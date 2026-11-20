import { z } from "zod";
import { categoryAttributes, validateCategoryAttributeValues } from "../catalog/category-attributes.ts";
import { scopedCatalogPilotRequested } from "../catalog/main-admin-config.ts";
import { getDb } from "../db/client.ts";
import { productIdField } from "./catalog-input.ts";
import { assignedAttributeSelection, assignedAttributeValues } from "./category-attribute-values.ts";
import { authorize, lockProductEdits, OperationError } from "./operations.ts";
import { CatalogWriteError, catalogWriteInput } from "./operation-error.ts";
import { categoryPlacementScope, lockTaxonomy } from "./taxonomy-write.ts";

const assignmentInput = z.strictObject({
  productId: productIdField,
  revision: z.number().int().nonnegative(),
  primaryCategoryId: productIdField,
  secondaryCategoryIds: z.array(productIdField).max(50),
}).superRefine(({ primaryCategoryId, secondaryCategoryIds }, ctx) => {
  const categories = [primaryCategoryId, ...secondaryCategoryIds];
  if (new Set(categories).size !== categories.length) {
    ctx.addIssue({ code: "custom", path: ["secondaryCategoryIds"], message: "Choose each category only once." });
  }
});

export async function saveProductCategoryAssignments(actorId: string, raw: unknown) {
  const { productId, revision, primaryCategoryId, secondaryCategoryIds } = catalogWriteInput(assignmentInput, raw);
  return getDb().$transaction(async tx => {
    await authorize(tx, actorId, true);
    await lockTaxonomy(tx);
    await lockProductEdits(tx, productId);
    await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR NO KEY UPDATE`;
    const current = await tx.product.findUnique({
      where: { id: productId },
      select: {
        departmentId: true, revision: true, publication: true, foundation: true,
        secondaryCategories: { select: { departmentId: true }, orderBy: { departmentId: "asc" } },
      },
    });
    if (!current) throw new CatalogWriteError("not_found", "The product does not exist.");
    if (!current.foundation && scopedCatalogPilotRequested()) {
      throw new CatalogWriteError("conflict", "Use the legacy catalog editor for this product’s category.");
    }
    if (current.revision !== revision) throw new CatalogWriteError("conflict", "This product changed. Reload its category assignments.");
    const secondary = [...secondaryCategoryIds].sort();
    const priorSecondary = current.secondaryCategories.map(item => item.departmentId).sort();
    const retainLegacyPrimary = primaryCategoryId === current.departmentId;
    const primary = await tx.department.count({ where: categoryPlacementScope([primaryCategoryId], retainLegacyPrimary) });
    const additional = await tx.department.count({ where: categoryPlacementScope(secondary, false) });
    if (primary !== 1 || additional !== secondary.length) {
      throw new OperationError("Choose active subcategories with active ancestors for new placements.");
    }
    if (!retainLegacyPrimary) {
      const templates = await categoryAttributes(primaryCategoryId, tx);
      const values = await tx.product.findUniqueOrThrow({ where: { id: productId }, select: { ...assignedAttributeSelection,
        optionDefinitions: { select: { key: true, values: { select: { value: true } } } },
      } });
      const invalid = validateCategoryAttributeValues(templates, assignedAttributeValues(values))
        .filter(issue => current.publication === "ACTIVE" || issue.reason !== "required").map(issue => issue.attributeId);
      for (const template of templates) {
        if (template.dataType !== "ENUM" || !template.variantOptionKey) continue;
        const option = values.optionDefinitions.find(definition => definition.key === template.variantOptionKey);
        if (option?.values.some(({ value }) => !template.allowedValues.includes(value))) invalid.push(template.id);
      }
      if (invalid.length) {
        const names = new Map(templates.map(template => [template.id, template.name]));
        const review = [...new Set(invalid)].slice(0, 6).map(id => names.get(id) ?? id).join(", ");
        throw new CatalogWriteError("conflict", `Use the product foundation editor to validate attributes for the proposed category. Review ${review}.`);
      }
    }
    const result = { productId, primaryCategoryId, secondaryCategoryIds: secondary };
    if (current.departmentId === primaryCategoryId && priorSecondary.length === secondary.length &&
      priorSecondary.every((id, index) => id === secondary[index])) return { ...result, revision };

    // Removing the old set first permits an atomic primary/secondary swap.
    await tx.productSecondaryCategory.deleteMany({ where: { productId } });
    const updated = await tx.product.update({
      where: { id: productId },
      data: { departmentId: primaryCategoryId, revision: { increment: 1 } },
      select: { revision: true },
    });
    await tx.productSecondaryCategory.createMany({
      data: secondary.map(departmentId => ({ productId, primaryDepartmentId: primaryCategoryId, departmentId })),
    });
    await tx.auditEvent.create({
      data: {
        actorId, action: "TAXONOMY_SAVED", target: productId,
        changes: { before: { primaryCategoryId: current.departmentId, secondaryCategoryIds: priorSecondary }, after: result, revision: updated.revision },
      },
    });
    return { ...result, ...updated };
  });
}

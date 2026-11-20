import { z } from "zod";
import { CatalogAttributeScope, CatalogAttributeType } from "../../generated/prisma/enums.ts";
import { getDb } from "../db/client.ts";
import { productIdField, textField } from "./catalog-input.ts";
import { authorize, OperationError } from "./operations.ts";
import { CatalogWriteError, catalogWriteInput } from "./operation-error.ts";
import { lockTaxonomy } from "./taxonomy-write.ts";

const definitionInput = z.strictObject({
  id: productIdField,
  name: textField(1, 100),
  scope: z.enum(CatalogAttributeScope),
  dataType: z.enum(CatalogAttributeType),
  allowedValues: z.array(textField(1, 240)).max(100).default([]),
  variantOptionKey: textField(1, 40).nullable().default(null),
}).superRefine((definition, context) => {
  const { allowedValues, dataType, scope, variantOptionKey } = definition;
  if (dataType === "ENUM" ? allowedValues.length === 0 : allowedValues.length > 0) {
    context.addIssue({ code: "custom", path: ["allowedValues"], message: "Enum attributes require allowed values. Other types must leave the list empty." });
  }
  if (new Set(allowedValues).size !== allowedValues.length) {
    context.addIssue({ code: "custom", path: ["allowedValues"], message: "Allowed values must be unique." });
  }
  if (variantOptionKey && (scope !== "VARIANT" || (dataType !== "TEXT" && dataType !== "ENUM"))) {
    context.addIssue({ code: "custom", path: ["variantOptionKey"], message: "Use an existing option key with a text or enum variant attribute." });
  }
  if (variantOptionKey && allowedValues.some(value => value.length > 70)) {
    context.addIssue({ code: "custom", path: ["allowedValues"], message: "Variant option values can contain at most 70 characters." });
  }
});

export const categoryAttributeTemplateInput = z.strictObject({
  departmentId: productIdField,
  attributeId: productIdField,
  expectedRevision: z.number().int().nonnegative(),
  template: z.strictObject({
    required: z.boolean(),
    filterable: z.boolean(),
    position: z.number().int().min(0).max(9999),
    inheritable: z.boolean().default(true),
    excluded: z.boolean().default(false),
  }).nullable(),
});

export async function saveCatalogAttributeDefinition(actorId: string, raw: unknown) {
  const definition = catalogWriteInput(definitionInput, raw);
  return getDb().$transaction(async tx => {
    await authorize(tx, actorId, true);
    await lockTaxonomy(tx);
    const existing = await tx.catalogAttributeDefinition.findUnique({ where: { id: definition.id } });
    if (existing) {
      if (existing.scope !== definition.scope || existing.dataType !== definition.dataType ||
          existing.variantOptionKey !== definition.variantOptionKey) {
        throw new OperationError("An issued attribute’s scope, data type and option binding are fixed.");
      }
      if (existing.allowedValues.some(value => !definition.allowedValues.includes(value))) {
        throw new OperationError("Removing allowed values requires reconciling the catalog first.");
      }
    }
    if (definition.variantOptionKey && await tx.catalogAttributeDefinition.findFirst({
      where: { variantOptionKey: definition.variantOptionKey, id: { not: definition.id } }, select: { id: true },
    })) {
      throw new OperationError("That variant option key is already bound to an attribute.");
    }
    const result = await tx.catalogAttributeDefinition.upsert({
      where: { id: definition.id }, create: definition,
      update: { name: definition.name, allowedValues: definition.allowedValues },
    });
    await tx.auditEvent.create({
      data: { actorId, action: "TAXONOMY_SAVED", target: definition.id,
        changes: { kind: "attribute-definition", before: existing, after: definition } },
    });
    return result;
  });
}

export async function saveCategoryAttributeTemplate(actorId: string, raw: unknown) {
  const { departmentId, attributeId, expectedRevision, template } = catalogWriteInput(categoryAttributeTemplateInput, raw);
  return getDb().$transaction(async tx => {
    await authorize(tx, actorId, true);
    await lockTaxonomy(tx);
    const department = await tx.department.findUnique({ where: { id: departmentId }, select: {
      kind: true, state: true, revision: true,
    } });
    if (!department?.kind || department.state === "ARCHIVED") {
      throw new CatalogWriteError("not_found", "Choose a typed category that has not been archived.");
    }
    if (department.revision !== expectedRevision) throw new CatalogWriteError("conflict", "The category changed. Reload and try again.");
    if (!await tx.catalogAttributeDefinition.findUnique({ where: { id: attributeId }, select: { id: true } })) {
      throw new CatalogWriteError("not_found", "The attribute definition does not exist.");
    }
    const key = { departmentId, attributeId };
    const where = { departmentId_attributeId: key };
    const before = await tx.categoryAttributeTemplate.findUnique({ where });
    if (template) await tx.categoryAttributeTemplate.upsert({ where, create: { ...key, ...template }, update: template });
    else if (before) await tx.categoryAttributeTemplate.delete({ where });
    const after = await tx.department.update({
      where: { id: departmentId }, data: { revision: { increment: 1 } }, select: { revision: true },
    });
    await tx.auditEvent.create({
      data: { actorId, action: "TAXONOMY_SAVED", target: departmentId,
        changes: { kind: "attribute-template", attributeId, before, after: template, revision: after.revision } },
    });
    return after;
  });
}

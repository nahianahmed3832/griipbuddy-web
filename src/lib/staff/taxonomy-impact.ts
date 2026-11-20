import type { Prisma } from "../../generated/prisma/client.ts";
import { departmentFamily } from "../catalog/departments.ts";
import { getDb } from "../db/client.ts";
import { productIdField } from "./catalog-input.ts";
import { CatalogWriteError, catalogWriteInput } from "./operation-error.ts";
import { authorize } from "./operations.ts";

function assignedTo(ids: string[]): Prisma.ProductWhereInput {
  return { OR: [{ departmentId: { in: ids } }, { secondaryCategories: { some: { departmentId: { in: ids } } } }] };
}

export async function readCategoryImpact(actorId: string, raw: unknown) {
  const id = catalogWriteInput(productIdField, raw);
  return getDb().$transaction(async tx => {
    await authorize(tx, actorId, true);
    const categories = await tx.department.findMany({ select: { id: true, kind: true, parentId: true, state: true, revision: true } });
    const category = categories.find(item => item.id === id);
    if (!category?.kind) throw new CatalogWriteError("not_found", "Choose an existing typed category.");
    const descendants = [...departmentFamily(categories, id)].filter(member => member !== id);
    const direct = assignedTo([id]);
    const [primary, additional, descendantProducts, activeDirect, menuLinks] = await Promise.all([
      tx.product.count({ where: { departmentId: id } }),
      tx.product.count({ where: { secondaryCategories: { some: { departmentId: id } } } }),
      tx.product.count({ where: { AND: [assignedTo(descendants), { NOT: direct }] } }),
      tx.product.count({ where: { ...direct, active: true, publication: "ACTIVE" } }),
      tx.marketMenuItem.count({ where: { departmentId: id } }),
    ]);
    const childCategories = descendants.length;
    const activeChildren = categories.filter(item => item.parentId === id && item.state === "ACTIVE").length;
    return {
      revision: category.revision, primary, additional, descendantProducts, childCategories, activeDirect, activeChildren, menuLinks,
      canArchive: category.state !== "ARCHIVED" && activeDirect === 0 && activeChildren === 0,
    };
  }, { isolationLevel: "RepeatableRead" });
}

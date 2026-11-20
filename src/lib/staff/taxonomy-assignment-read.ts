import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.ts";
import { departmentFamily } from "../catalog/departments.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { productIdField } from "./catalog-input.ts";
import { authorize } from "./operations.ts";
import { CatalogWriteError, catalogWriteInput } from "./operation-error.ts";

export type AssignmentCategory = {
  id: string;
  name: string;
  parentId: string | null;
  kind: "DEPARTMENT" | "CATEGORY" | "SUBCATEGORY" | null;
  state: "DRAFT" | "ACTIVE" | "ARCHIVED";
};

export const assignmentPageSize = 12;

const assignmentSearch = z.strictObject({
  categoryId: productIdField,
  scope: z.enum(["direct", "descendants", "all", "search"]).default("all"),
  q: z.string().trim().max(120).default(""),
  page: z.string().regex(/^[1-9][0-9]{0,4}$/).transform(Number).default(1),
});

export function catalogSearchParams(request: Request) {
  const params = new URL(request.url).searchParams;
  if (new Set(params.keys()).size !== params.size) {
    throw new CatalogWriteError("invalid_input", "Use one value per query field.");
  }
  return Object.fromEntries(params);
}

function assignedWithin(ids: string[]): Prisma.ProductWhereInput {
  return { OR: [{ departmentId: { in: ids } }, { secondaryCategories: { some: { departmentId: { in: ids } } } }] };
}

function productSearch(query: string): Prisma.ProductWhereInput {
  if (!query) return {};
  const contains = { contains: query, mode: "insensitive" } as const;
  return { OR: [{ id: contains }, { name: contains }, { slug: contains }, { brand: contains },
    { variants: { some: { sku: contains } } }] };
}

export async function categoryAssignmentProducts(actorId: string, raw: unknown, db: DbReader = getDb()) {
  await authorize(db, actorId, true);
  const { categoryId, scope, page, q } = catalogWriteInput(assignmentSearch, raw);
  const categories = await db.department.findMany({ select: { id: true, parentId: true } });
  if (!categories.some(category => category.id === categoryId)) {
    throw new CatalogWriteError("not_found", "This category was removed.");
  }
  const family = departmentFamily(categories, categoryId);
  family.delete(categoryId);
  const direct = assignedWithin([categoryId]);
  const descendants = { AND: [assignedWithin([...family]), { NOT: direct }] } satisfies Prisma.ProductWhereInput;
  const branches = { direct, descendants, all: { OR: [direct, descendants] }, search: {} };
  const where: Prisma.ProductWhereInput = { AND: [branches[scope], productSearch(q)] };
  const [total, products] = await Promise.all([
    db.product.count({ where }),
    db.product.findMany({
      where, skip: (page - 1) * assignmentPageSize, take: assignmentPageSize,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true, revision: true, active: true, publication: true, departmentId: true,
        secondaryCategories: { select: { departmentId: true }, orderBy: { departmentId: "asc" } } },
    }),
  ]);
  return {
    categoryId, scope, page, total, pages: Math.max(1, Math.ceil(total / assignmentPageSize)),
    products: products.map(({ secondaryCategories, departmentId, ...product }) => {
      const secondaryCategoryIds = secondaryCategories.map(row => row.departmentId);
      const placements = [departmentId, ...secondaryCategoryIds];
      return { ...product, primaryCategoryId: departmentId, secondaryCategoryIds,
        placement: placements.includes(categoryId) ? "direct" as const
          : placements.some(id => family.has(id)) ? "descendant" as const : "outside" as const };
    }),
  };
}

export type CategoryAssignmentPage = Awaited<ReturnType<typeof categoryAssignmentProducts>>;

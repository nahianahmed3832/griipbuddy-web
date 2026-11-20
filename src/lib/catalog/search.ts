import type { CatalogProduct, Department } from "./types.ts";

function normalize(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function scoreProduct(product: CatalogProduct, department: Pick<Department, "name" | "shortName"> | undefined, search: string): number {
  const name = normalize(product.name);
  const tags = normalize([
    department?.name, department?.shortName, ...product.keywords,
    ...product.specifications.flatMap(({ label, value }) => [label, value]),
    ...product.variants.filter((variant) => variant.offer).flatMap((variant) => Object.values(variant.options)),
  ].join(" "));
  const description = normalize(product.description);
  const matches = search.split(" ").map((term) => name.includes(term) ? 4 : tags.includes(term) ? 2 : description.includes(term) ? 1 : 0);
  if (matches.includes(0)) return 0;
  return (name.includes(search) ? 10 : 0) + matches.reduce<number>((total, match) => total + match, 0);
}

export function searchProducts(
  products: readonly CatalogProduct[],
  departments: ReadonlyMap<string, Pick<Department, "name" | "shortName">>,
  search: string,
): CatalogProduct[] {
  const terms = normalize(search);
  if (!terms) return [];
  return products.map((product) => ({ product, score: scoreProduct(product, departments.get(product.departmentId), terms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ product }) => product);
}

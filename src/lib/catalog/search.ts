import { deviceModelsByVariant, fitsSearchDevice, modelMentions, normalizeSearchText, phoneModels, type PhoneModel } from "./devices.ts";
import type { CatalogProduct, Department } from "./types.ts";

const filler = new Set(["for", "the", "a", "an", "fits", "fit", "compatible", "with"]);
const singular = new Map([["cases", "case"], ["covers", "cover"], ["protectors", "protector"]]);

export function searchDevice(search: string): PhoneModel | undefined {
  const models = phoneModels(search);
  return models.length === 1 ? models[0] : undefined;
}

function queryParts(text: string) {
  const normalized = normalizeSearchText(text);
  const mentions = modelMentions(normalized);
  const models = [...new Map(mentions.map(({ model }) => [model.id, model])).values()];
  let from = 0;
  const remainder: string[] = [];
  for (const mention of mentions) {
    remainder.push(normalized.slice(from, mention.start));
    from = mention.end;
  }
  remainder.push(normalized.slice(from));
  const terms = remainder.join(" ").trim().split(/\s+/).filter(term => term && (!models.length || !filler.has(term)));
  return { normalized, models, terms };
}

function textMatch(field: string, term: string) {
  if (/^[a-z]+\d+[a-z]*$/.test(term) || /^\d+$/.test(term)) return ` ${field} `.includes(` ${term} `);
  return field.includes(singular.get(term) ?? term);
}

function scoreProduct(product: CatalogProduct, department: Pick<Department, "name" | "shortName"> | undefined, query: ReturnType<typeof queryParts>) {
  const { normalized, models, terms } = query;
  const eligible = product.variants.filter(variant => variant.offer);
  const name = normalizeSearchText(product.name);
  let modelScore = 0;
  if (models.length) {
    const title = phoneModels(product.name);
    const matched = deviceModelsByVariant(product).flatMap(({ variant, models }) => variant.offer ? models : []);
    // A match on any requested model is appropriate for lists of alternatives.
    for (const requested of models) {
      if (matched.some(model => model.id === requested.id)) {
        modelScore = Math.max(modelScore, title.some(model => model.id === requested.id) ? 60 : 45);
      } else if (matched.some(model => fitsSearchDevice(model, requested))) {
        modelScore = Math.max(modelScore, 25);
      }
    }
    if (!modelScore) return 0;
  }
  const specifications = Array.isArray(product.specifications) ? product.specifications : [];
  const tags = normalizeSearchText([
    department?.name, department?.shortName, product.brand, ...product.keywords,
    ...specifications.flatMap(({ label, value }) => [label, value]),
    ...eligible.flatMap(variant => Object.values(variant.options)),
  ].join(" "));
  const description = normalizeSearchText(product.description);
  const matches = terms.map(term => textMatch(name, term) ? 4 : textMatch(tags, term) ? 2 : textMatch(description, term) ? 1 : 0);
  if (matches.includes(0)) return 0;
  // Formatting of a recognized model is immaterial to rank. Keep the free-text phrase bonus for ordinary searches.
  return modelScore + (!models.length && name.includes(normalized) ? 10 : 0) + matches.reduce<number>((total, match) => total + match, 0);
}

export function searchProducts(
  products: readonly CatalogProduct[],
  departments: ReadonlyMap<string, Pick<Department, "name" | "shortName">>,
  search: string,
): CatalogProduct[] {
  const query = queryParts(search);
  if (!query.normalized) return [];
  return products.map(product => ({ product, score: scoreProduct(product, departments.get(product.departmentId), query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ product }) => product);
}

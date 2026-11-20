import type { EffectiveCategoryAttribute } from "./category-attributes.ts";
import type { catalogVariants } from "./connected-public.ts";
import type { CatalogListingInput } from "./connected-listing-input.ts";
import { deviceLookupKey } from "./device-fitment.ts";
import { catalogSearchKey } from "./search-match.ts";

export const browseFacetLabels = {
  brand: "Brand", model: "Device or model", design: "Design", color: "Colour", availability: "Availability",
} as const;
export const browseAvailabilityLabels = {
  available: "In stock", out_of_stock: "Out of stock", delivery_unavailable: "Delivery unavailable", browse_only: "Browse only",
} as const;
type BaseField = keyof typeof browseFacetLabels;
type Field = BaseField | "option" | "attribute";
type Variant = Awaited<ReturnType<typeof catalogVariants>>[number];
type Attribute = { definition: EffectiveCategoryAttribute; value: string | number | boolean };
type Candidate = {
  field: Field; key: string; keys: string[]; label: string; value: string; aliases: string[];
  valueLabel: string; secondary?: boolean; boundKey?: string;
};
type FacetEntry = { value: string; label: string; count: number };
export type BrowseFacetGroup = { id: string; field: Field; label: string; values: FacetEntry[]; secondary?: boolean };

const label = (field: BaseField, value: string, valueLabel: string) =>
  field === "availability" ? browseAvailabilityLabels[value as keyof typeof browseAvailabilityLabels] ?? valueLabel : valueLabel;
const fold = (value: string) => value.normalize("NFKC").toLowerCase();
const facetId = ({ field, key }: { field: Field; key: string }) => key ? `${field}:${key}` : field;
const facetValue = ({ field, key, value }: Candidate) => field === "option" || field === "attribute" ? `${key}:${value}` : value;
const specialisedOptions = new Set(["model", "device", "device model", "phone model", "design", "pattern", "style", "color", "colour"]);

export function browseCandidateFacets(
  variant: Variant,
  facets: Record<BaseField, { value: string; label: string; matches: string[] }[]>,
  attributes: ReadonlyMap<string, Attribute>,
): Candidate[] {
  const base: Candidate[] = (Object.keys(browseFacetLabels) as BaseField[]).flatMap(field =>
    facets[field].map(choice => ({ field, key: "", keys: [], label: browseFacetLabels[field],
      value: choice.value, valueLabel: label(field, choice.value, choice.label), aliases: choice.matches })));
  const options: Candidate[] = variant.options.flatMap(option => {
    const key = deviceLookupKey(option.key);
    return key ? [{
      field: "option", key, keys: [key, deviceLookupKey(option.optionId ?? "")], label: option.label || option.key,
      value: option.value, aliases: [option.value, option.valueLabel, option.valueId ?? ""],
      valueLabel: option.valueLabel, secondary: specialisedOptions.has(key),
    }] : [];
  });
  const typed: Candidate[] = [...attributes.values()].map(({ definition, value }) => {
    const boundKey = definition.variantOptionKey ? deviceLookupKey(definition.variantOptionKey) : undefined;
    const encoded = JSON.stringify(value);
    return { field: "attribute", key: definition.id, keys: [definition.id], label: definition.name,
      value: encoded, aliases: [encoded], valueLabel: typeof value === "boolean" ? value ? "Yes" : "No" : String(value),
      secondary: boundKey ? specialisedOptions.has(boundKey) : false, boundKey };
  });
  return [...base, ...options, ...typed];
}

type Selected = { field: Field; key: string; value: string; raw: string };

function selectedFacets(filters: CatalogListingInput): Selected[] {
  return [
    ...(Object.keys(browseFacetLabels) as BaseField[]).flatMap(field =>
      filters[field].map(value => ({ field, key: "", value, raw: value }))),
    ...filters.option.map(({ key, value }) => ({ field: "option" as const, key, value, raw: `${key}:${value}` })),
    ...filters.attribute.map(({ key, value }) => ({ field: "attribute" as const, key, value: JSON.stringify(value), raw: `${key}:${JSON.stringify(value)}` })),
  ];
}

function matches(choice: Candidate, { field, key, value }: Selected) {
  if (choice.field !== field || key && !choice.keys.includes(key)) return false;
  if (field === "attribute") return choice.value === value;
  const normalized = fold(value);
  if (choice.aliases.some(alias => fold(alias) === normalized)) return true;
  const lookup = field === "model" ? catalogSearchKey(value) : "";
  return Boolean(lookup && choice.aliases.some(alias => catalogSearchKey(alias) === lookup));
}

export function reconcileBrowseFacets(filters: CatalogListingInput, candidates: readonly Candidate[][], keepUnmatched = false) {
  const values = new Map<string, Candidate>();
  const present = new Set<string>();
  const selections = selectedFacets(filters);
  for (const facets of candidates) {
    for (const value of facets) {
      const key = JSON.stringify([facetId(value), facetValue(value), ...value.aliases]);
      values.set(key, value);
    }
  }
  const selected = new URLSearchParams();
  const removed = new Set<string>();
  const retained = { ...filters };
  for (const field of Object.keys(browseFacetLabels) as BaseField[]) retained[field] = [];
  retained.option = [];
  retained.attribute = [];
  const knownStock = [...values.values()].some(choice =>
    choice.field === "availability" && choice.value !== "browse_only");

  for (const entry of selections) {
    const found = [...values.values()].filter(choice => matches(choice, entry));
    const stockFilter = entry.field === "availability" && (entry.value === "available" || entry.value === "out_of_stock");
    if (!found.length && !keepUnmatched && !(knownStock && stockFilter)) {
      const comparable = [...values.values()].find(choice => facetId(choice) === facetId(entry));
      removed.add(comparable?.label ?? (entry.field === "option" ? "Option" :
        entry.field === "attribute" ? "Specification" : browseFacetLabels[entry.field]));
      continue;
    }
    const canonical = new Set(found.map(facetValue));
    const raw = canonical.size === 1 ? canonical.values().next().value! : entry.raw;
    const unique = JSON.stringify([entry.field, raw]);
    if (present.has(unique)) continue;
    present.add(unique);
    selected.append(entry.field, raw);
    if (entry.field === "option") {
      const separator = raw.indexOf(":");
      retained.option.push({ key: raw.slice(0, separator), value: raw.slice(separator + 1) });
    } else if (entry.field === "attribute") {
      retained.attribute.push({ key: entry.key, value: JSON.parse(entry.value) as Attribute["value"] });
    } else if (entry.field === "availability") {
      retained.availability.push(raw as CatalogListingInput["availability"][number]);
    } else retained[entry.field].push(raw);
  }
  return { retained, selected, removed: [...removed] };
}

export function browseFacetCounts(filters: CatalogListingInput, locale: string) {
  const selected = new Map<string, Selected[]>();
  for (const item of selectedFacets(filters)) {
    const key = facetId(item);
    const group = selected.get(key) ?? [];
    group.push(item);
    selected.set(key, group);
  }
  const groups = new Map<string, BrowseFacetGroup & { counts: Map<string, { label: string; parents: Set<string> }> }>();
  const bound = new Set<string>();
  return {
    observe(productId: string, choices: Candidate[], eligible: boolean) {
      const mismatches = eligible ? [...selected].flatMap(([id, items]) =>
        choices.some(choice => items.some(item => matches(choice, item))) ? [] : [id]) : [];
      for (const choice of choices) {
        if (choice.boundKey) bound.add(choice.boundKey);
        const id = facetId(choice);
        const value = facetValue(choice);
        const group = groups.get(id) ?? { id, label: choice.label, field: choice.field, values: [],
          secondary: choice.secondary, counts: new Map() };
        const entry = group.counts.get(value) ?? { label: choice.valueLabel, parents: new Set<string>() };
        if (eligible && (mismatches.length === 0 || mismatches.length === 1 && mismatches[0] === id)) entry.parents.add(productId);
        group.counts.set(value, entry);
        groups.set(id, group);
      }
    },
    view(): BrowseFacetGroup[] {
      const availability = groups.get("availability");
      if (availability) {
        for (const value of filters.availability) {
          if (!availability.counts.has(value)) availability.counts.set(value, { label: browseAvailabilityLabels[value], parents: new Set() });
        }
      }
      return [...groups.values()].map(({ counts, ...group }) => ({
        ...group,
        secondary: group.secondary || group.field === "option" && bound.has(group.id.slice("option:".length)),
        values: [...counts.entries()].map(([value, { label, parents }]) => ({ value, label, count: parents.size }))
          .sort((a, b) => a.label.localeCompare(b.label, locale, { numeric: true }) || a.value.localeCompare(b.value, "en")),
      })).sort((a, b) => {
        const order = ["brand", "model", "design", "color", "option", "attribute", "availability"];
        return order.indexOf(a.field) - order.indexOf(b.field) || a.label.localeCompare(b.label, locale) || a.id.localeCompare(b.id, "en");
      });
    },
  };
}

export function catalogSearchKey(text: string) {
  return text.normalize("NFKC").toLowerCase().replace(/([\p{L}\p{N}])\+/gu, "$1 plus ")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();
}

const identifier = (text: string) => text.normalize("NFKC").trim().toLowerCase();
const tokens = (text: string) => catalogSearchKey(text).split(" ").filter(Boolean);
const modelNumber = (word: string) => /\p{N}/u.test(word) || /^[a-z]$/.test(word);
const modelQualifiers = new Set(["air", "edge", "fe", "lite", "max", "mini", "plus", "pro", "se", "ultra", "xl"]);
const queryWordLimit = 24;

export type CatalogSearchMatch = { kind: "sku" | "model" | "variant" | "text" | "spelling"; label: string };
export type SearchModel = { id?: string; label: string; names: readonly string[] };
export type SearchOption = { label: string; names: readonly string[] };
type SearchFields = {
  sku: string; modelNumber?: string | null; gtin?: string | null; label: string;
  title: string; text: readonly string[]; models: readonly SearchModel[]; options: readonly SearchOption[];
};
type ScoredMatch = { score: number; match: CatalogSearchMatch };
type Phrase = { key: string; start: number; end: number };

function queryPhrases(words: string[]) {
  return words.flatMap((_, start) => words.slice(start).map((_, offset) => ({
    start, end: start + offset + 1, key: words.slice(start, start + offset + 1).join(" "),
  }))).sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
}

export function searchablePhrases(query: string) {
  const words = tokens(query);
  return words.length <= queryWordLimit ? queryPhrases(words).map(({ key }) => key) : [];
}

function exclusivePhrases(phrases: Phrase[], lookup: ReadonlyMap<string, unknown>, ignored = new Set<number>()) {
  const claimed = new Set(ignored);
  return phrases.filter(phrase => {
    if (!lookup.has(phrase.key)) return false;
    for (let i = phrase.start; i < phrase.end; i++) if (claimed.has(i)) return false;
    for (let i = phrase.start; i < phrase.end; i++) claimed.add(i);
    return true;
  });
}

function oneEdit(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1 || !/^[\p{L}\p{M}]{5,40}$/u.test(a) ||
    !/^[\p{L}\p{M}]{4,41}$/u.test(b) || modelQualifiers.has(a) || modelQualifiers.has(b)) return false;
  const first = [...a].findIndex((letter, index) => letter !== b[index]);
  if (first === -1) return b.length === a.length + 1;
  if (a.length > b.length) return a.slice(first + 1) === b.slice(first);
  if (b.length > a.length) return a.slice(first) === b.slice(first + 1);
  return a.slice(first + 1) === b.slice(first + 1) || a[first] === b[first + 1] &&
    a[first + 1] === b[first] && a.slice(first + 2) === b.slice(first + 2);
}

export const exactSearchSkuScore = 100;
export const exactSearchIdentifierScore = 90;
export const searchSpellingScore = 10;

function optionLookup(options: readonly SearchOption[]) {
  const byName = new Map<string, string>();
  for (const option of options) for (const name of option.names) {
    const key = catalogSearchKey(name);
    if (key) byName.set(key, option.label);
  }
  return byName;
}

export function catalogSearchMatcher(raw: string, models: readonly SearchModel[], suggest = false) {
  const query = catalogSearchKey(raw);
  const words = tokens(raw);
  const phrases = words.length <= queryWordLimit ? queryPhrases(words) : [];
  const modelVocabulary = new Map<string, Set<string>>();
  const families = new Set<string>();
  for (const model of models) for (const name of model.names) {
    const key = catalogSearchKey(name);
    if (!key || !key.includes(" ") && key !== query && (!modelNumber(key) || key.length < 3)) continue;
    const ids = modelVocabulary.get(key) ?? new Set<string>();
    if (model.id) ids.add(model.id);
    modelVocabulary.set(key, ids);
    const names = tokens(name);
    const generation = names.findIndex(modelNumber);
    if (generation > 0) families.add(names[generation - 1]);
  }
  const modelPhrases = exclusivePhrases(phrases, modelVocabulary);
  const modelWords = new Set(modelPhrases.flatMap(({ start, end }) => words.slice(start, end).map((_, index) => start + index)));
  const unverifiedModel = words.some((word, index) => (families.has(words[index - 1]) && modelNumber(word) ||
    modelWords.has(index - 1) && (modelNumber(word) || modelQualifiers.has(word))) && !modelWords.has(index));

  return function match(fields: SearchFields, parentOptions: readonly SearchOption[]): ScoredMatch | null {
    const compared = identifier(raw);
    if (compared && identifier(fields.sku) === compared) return { score: exactSearchSkuScore, match: { kind: "sku", label: fields.sku } };
    const partNumber = [fields.modelNumber, fields.gtin].find(value => value && catalogSearchKey(value) === query);
    if (partNumber && query) return { score: exactSearchIdentifierScore, match: { kind: "variant", label: partNumber } };
    if (!phrases.length || unverifiedModel) return null;

    const modelNames = fields.models.map(model => ({ ...model, keys: model.names.map(catalogSearchKey) }));
    const matchedModels = modelPhrases.map(({ key }) => {
      const relatedIds = modelVocabulary.get(key)!;
      return modelNames.find(model => model.keys.includes(key) || (model.id ? relatedIds.has(model.id) : model.keys.some(name => {
        const ids = modelVocabulary.get(name);
        return ids?.size === 1 && relatedIds.has(ids.values().next().value!);
      })));
    });
    if (matchedModels.some(model => !model)) return null;
    const relevantOptions = optionLookup(fields.options);
    const optionPhrases = exclusivePhrases(phrases, optionLookup(parentOptions), modelWords);
    if (optionPhrases.some(({ key }) => !relevantOptions.has(key))) return null;
    const optionWords = new Set(optionPhrases.flatMap(({ start, end }) => words.slice(start, end).map((_, index) => start + index)));

    const title = catalogSearchKey(fields.title);
    const label = catalogSearchKey(fields.label);
    const text = new Set([fields.sku, fields.modelNumber ?? "", fields.gtin ?? "", fields.title, fields.label, ...fields.text,
      ...fields.options.flatMap(option => option.names), ...fields.models.map(model => model.label)].flatMap(tokens));
    if (suggest && fields.models.some(model => model.names.some(name => catalogSearchKey(name).startsWith(query)))) {
      for (const word of words) text.add(word);
    }
    const missing = words.filter((word, index) => !modelWords.has(index) && !optionWords.has(index) && !text.has(word) &&
      !(suggest && index === words.length - 1 && word.length >= 2 && [...text].some(term => term.startsWith(word))));
    if (missing.length) {
      if (suggest || matchedModels.length || words.some(word => /\p{N}/u.test(word)) || missing.length !== 1 ||
        ![...text].some(term => oneEdit(missing[0], term))) return null;
      return { score: searchSpellingScore, match: { kind: "spelling", label: "Similar text" } };
    }
    const model = matchedModels[0];
    if (model) return { score: 80 + optionPhrases.length, match: { kind: "model", label: model.label } };
    if (label === query || optionPhrases.length) {
      return { score: 70 + optionPhrases.length, match: { kind: "variant", label: label === query ? fields.label :
        optionPhrases.map(({ key }) => relevantOptions.get(key)).join(" · ") } };
    }
    return { score: title === query ? 60 : title.includes(query) ? 50 : 40, match: { kind: "text", label: "Product match" } };
  };
}

export function searchSuggestionName(query: string, name: string) {
  const wanted = catalogSearchKey(query);
  const value = catalogSearchKey(name);
  return wanted.length >= 2 && (value === wanted || value.startsWith(`${wanted} `) ||
    (` ${value}`).includes(` ${wanted}`));
}

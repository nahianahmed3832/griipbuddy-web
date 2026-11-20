import assert from "node:assert/strict";
import { test } from "node:test";
import { browseProductSelection, catalogProductHref, matchesBrowseProductSelection } from "../../src/lib/catalog/category-browse-links.ts";

const context = { id: "bd", locale: "bn-BD", regional: true } as const;
const blue = { key: "colour", value: "Blue", optionId: "finish-colour", valueId: "blue-1" };
const model = { key: "model", value: "Phone A", optionId: "handset", valueId: "phone-a-id" };

test("catalog links keep the shared parent, optional category and exact physical variant", () => {
  const address = new URL(catalogProductHref({ slug: "phone-case", matchedVariantId: "v-phone-case", knownOptions: [blue] },
    context, "phone-cases"), "https://fixture.invalid");
  assert.equal(address.pathname, "/bd/products/phone-case");
  assert.deepEqual(Object.fromEntries(address.searchParams), {
    market: "bd", variant: "v-phone-case", browse: "1", category: "phone-cases", lang: "bn-BD",
  });
});

test("ambiguous cards carry stable partial options and resolve only compatible rows", () => {
  const address = new URL(catalogProductHref({ slug: "phone-case", matchedVariantId: null, knownOptions: [blue, model] },
    context), "https://fixture.invalid");
  assert.equal(address.searchParams.has("variant"), false);
  const pairs = address.searchParams.getAll("option");
  assert.deepEqual(pairs, ["finish-colour:blue-1", "handset:phone-a-id"]);
  assert.equal(matchesBrowseProductSelection([blue, model], browseProductSelection(pairs)), true);
  assert.equal(matchesBrowseProductSelection([blue, { ...model, value: "Phone B", valueId: "phone-b-id" }], browseProductSelection(pairs)), false);
  assert.equal(matchesBrowseProductSelection([blue, model], browseProductSelection(["invalid", "model:PHONE A"])), true);
});

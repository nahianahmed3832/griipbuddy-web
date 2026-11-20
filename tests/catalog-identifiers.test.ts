import assert from "node:assert/strict";
import { test } from "node:test";
import { validGtin } from "../src/lib/catalog/identifiers.ts";
import { mergeCatalogIdentifiers, productInput, type ProductInput } from "../src/lib/staff/catalog-input.ts";
import { draftInput } from "../src/lib/staff/merchandising-input.ts";

const variant = { sku: "TEST-001", options: { Color: "Blue" }, active: true, offers: [] };
const draft: ProductInput = {
  id: "test-product", slug: "test-product", name: "Test product", departmentId: "accessories",
  description: "", specifications: [], keywords: [], collectionIds: [], images: [], variants: [variant],
  publication: "DRAFT", demo: true, featured: false, newArrival: false,
};

test("GTIN validation handles GS1 lengths, check digits, leading zeroes and restricted numbers", () => {
  for (const gtin of ["95010939", "042100005264", "4006381333931", "09504000059118"]) {
    assert.equal(validGtin(gtin), true, gtin);
  }
  for (const gtin of ["95010938", "42100005264", "20123452", "0412345678909", "00000000000000", "400638133393A", 4006381333931]) {
    assert.equal(validGtin(gtin), false, String(gtin));
  }
});

test("product and merchandising draft accept only optional confirmed manufacturer identifiers", () => {
  assert.deepEqual(productInput.parse(draft), draft);
  const values = { ...draft, brand: " Sample Maker ", variants: [{ ...variant, gtin: "042100-005264", mpn: " Model-1 " }] };
  const parsed = draftInput.parse(values);
  assert.equal(parsed.brand, "Sample Maker");
  assert.equal(parsed.variants[0].gtin, "042100005264");
  assert.equal(parsed.variants[0].mpn, "Model-1");
  assert.equal(draftInput.safeParse({ ...draft, publication: "ARCHIVED" }).success, false);
  assert.equal(productInput.safeParse({ ...draft, brand: "x".repeat(71) }).success, false);
  assert.equal(productInput.safeParse({ ...draft, variants: [{ ...variant, gtin: "042100005265" }] }).success, false);
  assert.equal(productInput.safeParse({ ...draft, variants: [{ ...variant, identifiersNotAssigned: true, mpn: "Model-1" }] }).success, false);
  assert.equal(productInput.safeParse({ ...draft, variants: [{ ...variant, identifiersNotAssigned: true, gtin: "042100005264" }] }).success, false);
  assert.equal(productInput.safeParse({ ...draft, variants: [{ ...variant, identifiersNotAssigned: true, gtin: null }] }).success, true);
});

test("partial edits preserve assigned identifiers and explicit clears in existing drafts", () => {
  const prior = { ...draft, brand: "Sample Maker", variants: [{ ...variant, gtin: "042100005264", mpn: null, identifiersNotAssigned: false }] };
  const edited = draftInput.parse(mergeCatalogIdentifiers({ ...draft, name: "Renamed product" }, prior));
  assert.equal(edited.brand, prior.brand);
  assert.deepEqual(edited.variants, prior.variants);

  const cleared = draftInput.parse(mergeCatalogIdentifiers({
    ...draft, brand: null, variants: [{ ...variant, gtin: null, identifiersNotAssigned: true }],
  }, prior));
  assert.equal(cleared.brand, null);
  assert.equal(cleared.variants[0].gtin, null);
  assert.equal(cleared.variants[0].identifiersNotAssigned, true);
});

import assert from "node:assert/strict";
import test from "node:test";
import { activeHomepageSections, homepageInput } from "../src/lib/catalog/homepage-contract.ts";
import { eligibleHomeProducts, homepageDealCards } from "../src/lib/catalog/homepage-offers.ts";
import type { CatalogProduct, MarketOffer } from "../src/lib/catalog/types.ts";

test("scheduled market overrides mask an inherited section only in their active local window", () => {
  const inherited = homepageInput.parse({ sections: [{ key: "picks", type: "FEATURED", title: "Shared picks", position: 2 }] });
  const override = homepageInput.parse({ sections: [{
    key: "picks", type: "FEATURED", title: "Scheduled disabled", position: 2, enabled: false,
    startsLocal: "2027-01-15T09:00", endsLocal: "2027-01-15T10:00",
  }, { key: "spotlight", type: "CATEGORY_SPOTLIGHT", title: "Market spotlight", position: 1, categoryId: "fixture-cases" }] });
  const sectionsAt = (at: string, timeZone: string) => activeHomepageSections([inherited, override], new Date(at), timeZone).map(section => section.key);
  assert.deepEqual(sectionsAt("2027-01-15T03:00:00Z", "Asia/Dhaka"), ["spotlight"]);
  assert.deepEqual(sectionsAt("2027-01-15T04:00:00Z", "Asia/Dhaka"), ["spotlight", "picks"]);
  assert.deepEqual(sectionsAt("2027-01-15T03:00:00Z", "America/New_York"), ["spotlight", "picks"]);
});

test("only typed and safe local destinations are accepted for homepage sections", () => {
  const section = { key: "cases", type: "CATEGORY_SPOTLIGHT", title: "Case spotlight", position: 2, categoryId: "fixture-cases" };
  const parse = (fields: object) => homepageInput.safeParse({ sections: [{ ...section, ...fields }] });
  assert.equal(parse({ link: { label: "Shop cases", href: "/departments/cases" } }).success, true);
  assert.equal(parse({ categoryId: undefined }).success, false);
  assert.equal(parse({ productIds: ["fixture-case"], budget: { currency: "BDT", amountMinor: 10 } }).success, false);
  for (const href of ["//evil.example", "/%2fevil.example", "javascript:alert(1)", "/checkout", "/shop?next=//evil.example"]) {
    assert.equal(parse({ link: { label: "Unsafe link", href } }).success, false);
  }
});

test("the established hero comes before body ordering even when a body position sorts first", () => {
  const layer = homepageInput.parse({ sections: [
    { key: "featured", type: "FEATURED", title: "Featured products", position: 1 },
    { key: "hero", type: "BANNER", title: "Established hero", position: 4 },
    { key: "summer", type: "BANNER", title: "Earlier banner", position: 2 },
  ] });
  assert.deepEqual(activeHomepageSections([layer], new Date(), "Asia/Dhaka").map(section => section.key),
    ["hero", "featured", "summer"]);
});

test("deals render the eligible promoted variant and its own image and price", () => {
  const image = (id: string) => ({ src: `/catalog/${id}.webp`, alt: id });
  const variant = (id: string, amountMinor: number, terms: Partial<MarketOffer> = {}) => ({
    id, image: image(id), options: {}, offer: { variantId: id, marketId: "bd", currency: "BDT", amountMinor, stock: 1, ...terms } as MarketOffer,
  });
  const product: CatalogProduct = {
    id: "case", slug: "case", name: "Case", departmentId: "cases", addedOn: "2026-11-20", description: "",
    specifications: [], keywords: [], images: [image("case")],
    variants: [
      variant("cheap", 1_200),
      variant("promoted", 1_999, { regularMinor: 2_000, promotion: { endsAt: "2027-01-15T10:00:00Z", remainingSeconds: 10 } }),
      variant("sold-out", 1_500, { regularMinor: 2_000, stock: 0, promotion: { endsAt: "2027-01-15T10:00:00Z", remainingSeconds: 10 } }),
      variant("other-market", 5, { marketId: "us", currency: "USD" }),
      variant("former-price", 1_900, { regularMinor: 2_000 }),
    ],
  };
  const candidates = eligibleHomeProducts([product], { id: "bd", currency: "BDT" });
  const [deal] = homepageDealCards(candidates, "BDT");
  assert.equal(deal.variantId, "promoted");
  assert.equal(deal.image.src, "/catalog/promoted.webp");
  assert.equal(deal.priceMinor, 1_999);
  const [budget] = homepageDealCards(candidates, "BDT", { currency: "BDT", amountMinor: 1_300 });
  assert.equal(budget.variantId, "cheap");
  assert.deepEqual(homepageDealCards(candidates, "BDT", { currency: "USD", amountMinor: 1_300 }), []);
});

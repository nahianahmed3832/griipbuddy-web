import assert from "node:assert/strict";
import { test } from "node:test";
import { markets } from "../../src/config/markets.ts";
import { categoryBrowseControls, prepareCategoryBrowseQuery } from "../../src/lib/catalog/category-browse-query.ts";

test("category pages validate filters, translate legacy links and parse local prices exactly", () => {
  const prepared = prepareCategoryBrowseQuery({
    device: "Phone A", color: [" Blue ", "Blue"], attribute: ['magnetic:true', 'malformed:{"no":"object"}'],
    minPrice: "১২.৩৪", maxPrice: "112.55", sort: "price-high", market: "bd", lang: "en-BD", page: "3",
  }, markets.bd, { category: "cases" });

  assert.equal(prepared.page, 3);
  assert.equal(prepared.sort, "price-high");
  assert.equal(prepared.params.get("category"), "cases");
  assert.equal(prepared.params.get("model"), "Phone A");
  assert.deepEqual(prepared.params.getAll("color"), ["Blue"]);
  assert.deepEqual(prepared.params.getAll("attribute"), ["magnetic:true"]);
  assert.equal(prepared.params.get("minMinor"), "1234");
  assert.equal(prepared.params.get("maxMinor"), "11255");
  assert.deepEqual(prepared.removed, ["Specification"]);

  const controls = categoryBrowseControls(prepared, { selected: "model=device-a&color=blue&attribute=magnetic%3Atrue", removed: [] });
  const query = new URLSearchParams(controls.query);
  assert.equal(query.get("market"), "bd");
  assert.equal(query.get("lang"), "en-BD");
  assert.equal(query.get("priceCurrency"), "BDT");
  assert.equal(query.get("category"), null);
  assert.equal(query.get("page"), null);
  assert.equal(query.get("model"), "device-a");
  assert.deepEqual(controls.filterFields, ["price", "model", "color", "attribute"]);
});

test("switching markets drops old currency amounts and delivery context, retaining applicable dimensions", () => {
  const prepared = prepareCategoryBrowseQuery({
    market: "us", lang: "en-US", browseFrom: "bd", minMinor: "1000", color: "Black", brand: "Fixture",
    priceCurrency: "BDT", page: "7", country: "BD", district: "dhaka", method: "ground", paymentMethod: "COD",
  }, markets.us, { category: "cases" });
  const controls = categoryBrowseControls(prepared, { selected: "color=black", removed: ["Brand"] });
  assert.equal(prepared.page, 1);
  assert.equal(prepared.delivery, undefined);
  assert.equal(prepared.params.has("minMinor"), false);
  assert.equal(controls.query, "market=us&lang=en-US&color=black");
  assert.deepEqual(controls.filterFields, ["color"]);
  assert.match(controls.notice ?? "", /don’t apply in this market: Price, Delivery, Brand/);
  assert.equal(categoryBrowseControls(prepareCategoryBrowseQuery({ page: "2" }, markets.us, {})).filterKey,
    categoryBrowseControls(prepareCategoryBrowseQuery({ sort: "name" }, markets.us, {})).filterKey);
});

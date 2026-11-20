import assert from "node:assert/strict";
import { test } from "node:test";
import {
  browseRequestState, clearBrowseFilters, needsBrowseUrlNormalization, normalizedBrowseUrl,
} from "../src/lib/catalog/browse-url-state.ts";

test("catalog URL correction applies only to the original result criteria", () => {
  const source = browseRequestState({ market: "us", lang: "en-US", model: "obsolete", page: "999" });
  const query = "market=us&lang=en-US";
  assert.equal(needsBrowseUrlNormalization(source, 1, true), true);

  const original = new URL("http://localhost/departments/cases?lang=en-US&market=us&page=999&model=obsolete&utm_source=email#results");
  assert.equal(normalizedBrowseUrl(original, source, query, 1)?.href,
    "http://localhost/departments/cases?utm_source=email&market=us&lang=en-US#results");

  original.searchParams.set("model", "phone-a");
  assert.equal(normalizedBrowseUrl(original, source, query, 1), null);
  original.searchParams.set("model", "obsolete");
  original.searchParams.set("market", "bd");
  assert.equal(normalizedBrowseUrl(original, source, query, 1), null);
});

test("clearing facets returns to page one with the same market, search and sort", () => {
  const query = "market=bd&lang=bn-BD&q=case&model=a&model=b&minMinor=400&priceCurrency=BDT&sort=price-low&page=2";
  assert.equal(clearBrowseFilters("/departments/cases", query), "/departments/cases?market=bd&lang=bn-BD&q=case&sort=price-low");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { readSearchQuery, searchQueryMaxLength } from "../src/lib/catalog/search-query.ts";

test("search takes one bounded term without rewriting device names or their spacing", () => {
  assert.equal(readSearchQuery(undefined), "");
  assert.equal(readSearchQuery("   "), "");
  assert.equal(readSearchQuery("  Aster 18 Pro Max+  "), "Aster 18 Pro Max+");
  assert.equal(readSearchQuery("কভার"), "কভার");
  assert.equal(readSearchQuery(["Phone A", "Phone B"]), null);
  assert.equal(readSearchQuery("Phone\u0000Max"), null);
  assert.equal(readSearchQuery("x".repeat(searchQueryMaxLength + 1)), null);
});

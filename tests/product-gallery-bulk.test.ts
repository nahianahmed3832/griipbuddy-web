import test from "node:test";
import assert from "node:assert/strict";
import { applyVariantPrimaryImage } from "../src/lib/catalog/product-gallery-bulk.ts";

const image = { src: "/catalog/brown-shoe.webp", alt: "Side view" };
const companion = { src: "/catalog/black-shoe.webp", alt: "Other view", position: 0, isPrimary: true };

test("bulk media keeps existing associations, uses each confirmed revision and reports partial failures", async () => {
  const sent: Array<{ id: string; revision: number }> = [];
  const outcome = await applyVariantPrimaryImage([
    { id: "a", images: [companion] },
    { id: "b", images: [] },
    { id: "c", images: [companion, { ...image, isPrimary: false, position: 1 }] },
    { id: "d", images: [{ ...image, isPrimary: true, position: 0 }] },
  ], image, 7, async (id, revision, gallery) => {
    sent.push({ id, revision });
    if (id === "b") throw Object.assign(new Error("The variant is archived."), { status: 404 });
    assert.deepEqual(gallery, [{ ...image, isPrimary: true }, { src: companion.src, alt: companion.alt, isPrimary: false }]);
    return { revision: revision + 1, result: gallery.map((row, position) => ({ ...row, position })) };
  });

  assert.deepEqual(sent, [{ id: "a", revision: 7 }, { id: "b", revision: 8 }, { id: "c", revision: 8 }]);
  assert.equal(outcome.revision, 9);
  assert.deepEqual(outcome.entries.map(row => row.status), ["saved", "failed", "saved", "unchanged"]);
});

test("bulk media stops after an unconfirmed write or a stale revision", async () => {
  for (const failure of [new TypeError("Failed to fetch"), Object.assign(new Error("Product changed"), { status: 409 })]) {
    let requests = 0;
    const outcome = await applyVariantPrimaryImage([
      { id: "a", images: [] }, { id: "b", images: [] },
    ], image, 7, async () => {
      requests += 1;
      throw failure;
    });
    assert.equal(requests, 1);
    assert.equal(outcome.revision, 7);
    assert.deepEqual(outcome.entries.map(row => row.status), [failure instanceof TypeError ? "unconfirmed" : "failed", "skipped"]);
  }
});

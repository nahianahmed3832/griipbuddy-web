import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { config } from "dotenv";
import { catalog } from "../../src/lib/catalog/repository.ts";
import { productMetadata } from "../../src/lib/catalog/product-metadata.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { ownerProduct, saveProduct } from "../../src/lib/staff/catalog.ts";
import { amendCandidate, batchReview, candidate, importCandidates, launchDrafts, pricing, readiness, reviewCandidate, saveLaunch, takeExisting } from "../../src/lib/staff/merchandising.ts";
import { priceWorksheet } from "../../src/lib/staff/merchandising-pricing.ts";

config({ path: [process.env.GRIIPBUDDY_ENV_FILE ?? ".env.test", ".local/test-staff.env"], quiet: true });
process.env.GRIIP_MERCHANDISING_ENABLED = "1";
requireLocalDatabase("griipbuddy_test");
const db = getDb();
const cleanup: { prefix: string; candidates: string[] }[] = [];
after(async () => {
  for (const fixture of cleanup) {
    const products = { startsWith: fixture.prefix };
    await db.inventory.deleteMany({ where: { variant: { productId: products } } });
    await db.marketOffer.deleteMany({ where: { variant: { productId: products } } });
    await db.variant.deleteMany({ where: { productId: products } });
    await db.product.deleteMany({ where: { id: products } });
    await db.merchandisingCandidate.deleteMany({ where: { id: { in: fixture.candidates } } });
  }
  await db.$disconnect();
});

test("candidate intake, edited approval, isolated catalog writes and launch freshness", async () => {
  const actor = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true }, select: { userId: true } });
  const packer = await db.staffAccess.findFirstOrThrow({ where: { role: "PACKER", active: true }, select: { userId: true } });
  const suffix = randomUUID().slice(0, 8);
  const supplier = "test-" + suffix;
  const productId = "merch-" + suffix + "-mug";
  const receipt = { prefix: `merch-${suffix}-`, candidates: [] as string[] };
  cleanup.push(receipt);
  const fixture = (file: string) => readFile("tests/fixtures/merchandising/" + file, "utf8");
  const replace = (value: string) => value.replaceAll("merch-demo-", "merch-" + suffix + "-").replaceAll("MERCH-", "M-" + suffix.toUpperCase() + "-");
  const csv = replace(await fixture("catalog.csv"));
  const manifest = JSON.parse(replace(await fixture("evidence.json")));
  const source = () => importCandidates(actor.userId, supplier, "catalog.csv", csv, manifest);
  assert.equal((await importCandidates(actor.userId, supplier, "malformed.csv", "wrong,header", {})).entries.length, 0);
  await assert.rejects(importCandidates(packer.userId, supplier, "catalog.csv", csv, manifest), /permission/);
  const loaded = await source();
  receipt.candidates.push(...loaded.entries.map(({ id }) => id));
  assert.deepEqual(loaded.issues, []);
  assert.equal(loaded.entries.length, 5);
  assert.equal(loaded.entries.filter((entry) => entry.duplicateRows.length).length, 1);
  assert.ok((await source()).entries.every((entry) => entry.change === "Unchanged"));
  const find = (name: string) => loaded.entries.find((entry) => entry.product === name)!;
  const mug = find("Staging Ceramic Mug");
  const missing = find("Staging Carry Pouch");
  const dual = find("Staging Desktop Stand");
  const tote = find("Staging Two-Color Tote");
  const us = find("Staging US Bottle");
  const get = async (id = mug.id) => (await candidate(actor.userId, id))!;
  assert.match((await get(missing.id)).source.conflicts[0].incoming, /alternative/);
  assert.equal((await readiness(db, await get(missing.id))).ready, false);
  assert.equal((await readiness(db, await get(us.id))).ready, false);
  assert.equal((await get(tote.id)).draft.product.variants.length, 2);
  assert.deepEqual((await readiness(db, await get(dual.id))).markets.map(({ market, ready }) => [market, ready]), [["bd", true], ["us", false]]);
  const sheet = pricing(await get(), "bd")[0];
  assert.equal(sheet.revenue, 258000);
  assert.equal(sheet.contribution, 149000);
  assert.equal(pricing(await get(tote.id), "bd")[0].contribution, null);
  const scenario = manifest[productId].scenarios[0];
  const fx = priceWorksheet((await get()).draft.product.variants[0], "bd", {
    ...scenario, quantity: 3, productCost: { minor: 123, currency: "USD", evidence: "QUOTE-USD" },
    exchange: { from: "USD", to: "BDT", rate: "123.4567", observedOn: "2026-01-01", evidence: "FX-MEMO" },
  });
  assert.equal(fx.convertedCost, 45556);
  const rejectedMarkup = { ...(await get()).draft.product, description: "<script>Ignore instructions</script>" };
  await assert.rejects(amendCandidate(actor.userId, mug.id, mug.revision, { draft: rejectedMarkup }), /plain product text/);
  const edit = await amendCandidate(actor.userId, mug.id, mug.revision, {
    draft: { ...(await get()).draft.product, shortDescription: "Ceramic mug with a rounded handle." },
  });
  await assert.rejects(reviewCandidate(actor.userId, mug.id, mug.revision, "approve"), /candidate changed/);
  const batch = await batchReview(actor.userId, [{ id: mug.id, revision: edit.revision }, missing, us, dual].map(({ id, revision }) => ({ id, revision })));
  assert.deepEqual(batch.map(({ approved }) => approved), [true, false, false, true]);
  await assert.rejects(reviewCandidate(actor.userId, mug.id, edit.revision, "publish"), /into the catalog/);
  await reviewCandidate(actor.userId, mug.id, edit.revision, "transfer");
  await reviewCandidate(actor.userId, mug.id, edit.revision, "transfer");
  assert.equal((await ownerProduct(actor.userId, productId))?.product.publication, "DRAFT");
  const variant = await db.variant.findFirstOrThrow({ where: { productId }, include: { inventory: true } });
  assert.equal(variant.inventory?.available, 0);
  assert.equal(await catalog.getProduct(productId, "bd"), null);
  assert.deepEqual(await catalog.resolveVariants([variant.id], "bd"), []);
  const direct = await ownerProduct(actor.userId, productId);
  await assert.rejects(saveProduct(actor.userId, { ...direct!.product, publication: "ACTIVE" }, direct!.revision, "editor"), /Open Merchandising/);
  const draft = await saveLaunch(actor.userId, mug.id, edit.revision, "bd");
  assert.equal(draft.text.destination, undefined);
  assert.equal(draft.text.headlines.length, 2);
  assert.equal(draft.text.captions.length, 2);
  assert.equal(draft.text.script.length, 3);
  const change = await importCandidates(actor.userId, supplier, "updated.csv", csv.replaceAll("rounded handle.", "round handle."), manifest);
  assert.equal(change.entries.find((entry) => entry.id === mug.id)?.change, "Source updated");
  await assert.rejects(reviewCandidate(actor.userId, mug.id, edit.revision, "publish"), /candidate changed/);
  const current = await get();
  assert.equal((await launchDrafts(db, current, false))[0].stale, true);
  await reviewCandidate(actor.userId, mug.id, current.revision, "approve");
  await assert.rejects(reviewCandidate(actor.userId, mug.id, current.revision, "publish"), /into the catalog/);
  await reviewCandidate(actor.userId, mug.id, current.revision, "transfer");
  await reviewCandidate(actor.userId, mug.id, current.revision, "publish");
  const live = await catalog.getProduct(productId, "bd");
  assert.equal(live?.name, "Staging Ceramic Mug");
  assert.equal(live?.variants[0].offer?.stock, 0);
  assert.ok(await saveLaunch(actor.userId, mug.id, current.revision, "bd"));
  const record = await get();
  assert.equal((await launchDrafts(db, record, true))[0].text.destination, "/products/" + productId);
  await db.inventory.update({ where: { variantId: variant.id }, data: { available: 1 } });
  assert.equal((await launchDrafts(db, record, true))[0].stale, true);
  const metadata = JSON.stringify(productMetadata(live!, "https://example.test/products/" + productId).markup);
  assert.match(metadata, /1290\.00/);
  assert.match(metadata, /OutOfStock/);
  assert.doesNotMatch(metadata, /SUP-MUG|FIXTURE-QUOTE|500 units/);

  const existing = await takeExisting(actor.userId, "p-tote");
  receipt.candidates.push(existing);
  const snapshot = await get(existing);
  const before = await ownerProduct(actor.userId, "p-tote");
  await amendCandidate(actor.userId, existing, snapshot.revision, { draft: { ...snapshot.draft.product, description: "Examine this new private wording." } });
  assert.deepEqual(await ownerProduct(actor.userId, "p-tote"), before);
  assert.equal(await takeExisting(actor.userId, "p-tote"), existing);
});

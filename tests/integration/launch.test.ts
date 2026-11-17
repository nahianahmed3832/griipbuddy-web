import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import "../../scripts/load-env.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { catalog } from "../../src/lib/catalog/repository.ts";
import { guestOrder, reviewCheckout, submitCheckout } from "../../src/lib/commerce/orders.ts";
import type { CheckoutDetails } from "../../src/lib/commerce/checkout-types.ts";
import { applyImport, previewImport } from "../../src/lib/staff/catalog-import.ts";
import { ownerProduct, saveProduct } from "../../src/lib/staff/catalog.ts";
import { adjustStock, cancelOrder } from "../../src/lib/staff/operations.ts";
import { saveDeliveryZone, saveMarketPolicy } from "../../src/lib/staff/market-settings.ts";
import { consumeQuota } from "../../src/lib/db/observability.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

async function staff(role: "OWNER" | "PACKER") {
  return (await db.staffAccess.findFirstOrThrow({ where: { role, active: true } })).userId;
}

function checkout(variantId: string, district = "dhaka"): CheckoutDetails {
  return {
    marketId: "bd", items: [{ variantId, quantity: 1 }], paymentMethod: "COD", deliveryMethod: "standard",
    customer: { name: "Launch test shopper", phone: "01700000000", district, locality: "Test Area", address: "20 Test Road" },
  };
}

test("CSV preview validates rows and protects access, file content, and existing SKUs", async () => {
  const owner = await staff("OWNER");
  const csv = await readFile("public/templates/catalog-example.csv", "utf8");
  const input = csv.replaceAll("sample-import-tote", "fixture-invalid-import").replaceAll("DEMO-IMPORT-TOTE", "FIXTURE-INVALID-TOTE");
  const invalid = await previewImport(owner, input.replace("125000,BDT,true", "-99,GBP,true"));
  assert.ok(invalid.issues.some(({ row, message }) => row === 2 && /minor units/.test(message)));
  assert.equal(invalid.token, undefined);
  const badCurrency = await previewImport(owner, input.replace("125000,BDT,true", "125000,GBP,true"));
  assert.ok(badCurrency.issues.some(({ row, message }) => row === 2 && /BDT/.test(message)));
  const badOptions = await previewImport(owner, input.replace('"{""Color"":""Oat""}"', "broken"));
  assert.ok(badOptions.issues.some(({ row, message }) => row === 2 && /JSON/.test(message)));
  const collision = await previewImport(owner, input.replace("FIXTURE-INVALID-TOTE-OAT", "gb-tote-oat"));
  assert.ok(collision.issues.some(({ row, message }) => row === 2 && /already belongs/.test(message)));
  await assert.rejects(previewImport(await staff("PACKER"), input), /permission/);
  const preview = await previewImport(owner, input);
  assert.ok(preview.token);
  await assert.rejects(applyImport(owner, input.replaceAll("125000", "125001"), preview.token), /fresh preview/);
  assert.equal(await db.product.count({ where: { id: "fixture-invalid-import" } }), 0);
});

test("import is repeatable and preserves allocated stock and order snapshots through archive", async () => {
  const owner = await staff("OWNER");
  const suffix = randomUUID().slice(0, 8);
  const id = `fixture-catalog-${suffix}`;
  const code = `FIXTURE-TOTE-${suffix.toUpperCase()}`;
  const csv = (await readFile("public/templates/catalog-example.csv", "utf8"))
    .replaceAll("sample-import-tote", id).replaceAll("DEMO-IMPORT-TOTE", code).replaceAll(",DRAFT,", ",ACTIVE,");
  const district = `catalog-test-${[...suffix].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("")}`;
  let orderId: string | undefined;
  try {
    await saveDeliveryZone(owner, {
      marketId: "bd", district, districtLabel: "Catalog Test District", method: "standard", label: "Test delivery",
      guidance: "", chargeMinor: 8000, enabled: true, codEligible: true, revision: null,
    });
    const preview = await previewImport(owner, csv);
    assert.deepEqual(preview.issues, []);
    assert.equal(preview.entries[0].status, "New");
    assert.ok(preview.token);
    assert.deepEqual(await applyImport(owner, csv, preview.token), [{ id, status: "New" }]);
    const repeated = await previewImport(owner, csv);
    assert.equal(repeated.entries[0].status, "Unchanged");
    assert.ok(repeated.token);
    assert.deepEqual(await applyImport(owner, csv, repeated.token), [{ id, status: "Unchanged" }]);
    const branded = await ownerProduct(owner, id);
    assert.ok(branded);
    assert.equal(await saveProduct(owner, {
      ...branded.product,
      brand: "Test Maker",
      variants: branded.product.variants.map((item) =>
        item.sku === `${code}-OAT` ? { ...item, gtin: "042100-005264", mpn: "Tote-1" } : { ...item, identifiersNotAssigned: true }),
    }, branded.revision, "editor"), "Update");
    assert.equal(await db.variant.count({ where: { productId: id } }), 2);
    const variant = await db.variant.findUniqueOrThrow({ where: { sku: `${code}-OAT` }, include: { inventory: true } });
    assert.equal(variant.inventory?.available, 0);
    const guest = randomBytes(32).toString("hex");
    const input = checkout(variant.id, district);
    assert.equal((await reviewCheckout(input, "bd", guest)).kind, "unavailable");
    await adjustStock(owner, { variantId: variant.id, delta: 2, reason: "Receive sample test stock" });
    const review = await reviewCheckout(input, "bd", guest);
    assert.equal(review.kind, "review");
    const submit = await submitCheckout({ ...input, attemptId: review.attemptId, reviewToken: review.quote.reviewToken }, "bd", guest);
    assert.equal(submit.kind, "placed");
    orderId = submit.orderId;

    const changed = csv.replaceAll("125000", "139000").split(/\r?\n/).slice(0, 2).join("\n");
    const update = await previewImport(owner, changed);
    assert.equal(update.entries[0].status, "Update");
    assert.ok(update.token);
    assert.deepEqual(await applyImport(owner, changed, update.token), [{ id, status: "Update" }]);
    assert.equal(await db.variant.count({ where: { productId: id } }), 2);
    assert.equal((await db.inventory.findUniqueOrThrow({ where: { variantId: variant.id } })).available, 1);
    assert.equal((await guestOrder(orderId, guest))?.items[0].unitPriceMinor, 125000);

    const existing = await ownerProduct(owner, id);
    assert.ok(existing);
    assert.equal(existing.product.brand, "Test Maker");
    const identified = existing.product.variants.find(({ sku }) => sku === `${code}-OAT`);
    assert.equal(identified?.gtin, "042100005264");
    assert.equal(identified?.mpn, "Tote-1");
    assert.equal(existing.product.variants.find(({ sku }) => sku !== `${code}-OAT`)?.identifiersNotAssigned, true);
    await assert.rejects(saveProduct(owner, { ...existing.product, images: [] }, existing.revision, "editor"), /gallery image/);
    await saveProduct(owner, {
      ...existing.product,
      brand: null,
      variants: existing.product.variants.map((item) =>
        item.sku === `${code}-OAT` ? { ...item, gtin: null, mpn: null } : { ...item, identifiersNotAssigned: false }),
      publication: "ARCHIVED",
    }, existing.revision, "editor");
    const archived = await ownerProduct(owner, id);
    assert.ok(archived);
    assert.equal(archived.product.brand, undefined);
    assert.ok(archived.product.variants.every((item) => !item.gtin && !item.mpn && !item.identifiersNotAssigned));
    assert.equal(await catalog.getProduct(id, "bd"), null);
    assert.equal((await reviewCheckout(input, "bd", guest)).kind, "unavailable");
    assert.equal((await guestOrder(orderId, guest))?.items[0].sku, `${code}-OAT`);
    await cancelOrder(owner, orderId);
    assert.equal((await db.inventory.findUniqueOrThrow({ where: { variantId: variant.id } })).available, 2);
  } finally {
    if (orderId) {
      const { attemptId } = await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { attemptId: true } });
      await db.fulfillmentEvent.deleteMany({ where: { orderId } });
      await db.payment.deleteMany({ where: { orderId } });
      await db.orderItem.deleteMany({ where: { orderId } });
      await db.order.delete({ where: { id: orderId } });
      await db.checkoutAttempt.delete({ where: { id: attemptId } });
    }
    await db.auditEvent.deleteMany({ where: { OR: [{ target: id }, { target: { in: (await db.variant.findMany({ where: { productId: id }, select: { id: true } })).map((variant) => variant.id) } }, ...(orderId ? [{ target: orderId }] : [])] } });
    await db.inventory.deleteMany({ where: { variant: { productId: id } } });
    await db.marketOffer.deleteMany({ where: { variant: { productId: id } } });
    await db.variant.deleteMany({ where: { productId: id } });
    await db.product.deleteMany({ where: { id } });
    await db.deliveryZone.deleteMany({ where: { district } });
    await db.auditEvent.deleteMany({ where: { target: `bd/${district}/standard` } });
  }
});

test("market rules require configured tax and shipping, apply COD eligibility, and lock quoted guidance", async () => {
  const owner = await staff("OWNER");
  const packer = await staff("PACKER");
  const district = "staging-test-district";
  const zone = {
    marketId: "bd", district, districtLabel: "Staging Test District", method: "standard", label: "Test service",
    guidance: "Test guidance A", chargeMinor: null, enabled: true, codEligible: true, revision: null,
  };
  const policy = await db.checkoutPolicy.findUniqueOrThrow({ where: { marketId: "bd" } });
  await assert.rejects(saveMarketPolicy(owner, { ...policy, enabled: true, taxBasisPoints: null, taxLabel: "" }), /explicit tax rate/);
  await assert.rejects(saveMarketPolicy(owner, { ...policy, marketId: "us", enabled: true }), /only for Bangladesh/);
  await assert.rejects(saveDeliveryZone(packer, { ...zone, chargeMinor: 9000 }), /permission/);
  await assert.rejects(saveDeliveryZone(owner, zone), /shipping charge/);
  try {
    await saveDeliveryZone(owner, { ...zone, chargeMinor: 0, codEligible: false });
    const guest = randomBytes(32).toString("hex");
    const input = checkout("v-tote-oat", district);
    assert.equal((await reviewCheckout(input, "bd", guest)).kind, "unavailable");
    await saveDeliveryZone(owner, { ...zone, chargeMinor: 0, revision: 0 });
    const review = await reviewCheckout(input, "bd", guest);
    assert.equal(review.kind, "review");
    assert.equal(review.quote.deliveryMinor, 0);
    assert.equal(review.quote.deliveryGuidance, "Test guidance A");
    await saveDeliveryZone(owner, { ...zone, chargeMinor: 100, guidance: "Test guidance B", revision: 1 });
    const changed = await submitCheckout({ ...input, attemptId: review.attemptId, reviewToken: review.quote.reviewToken }, "bd", guest);
    assert.equal(changed.kind, "changed");
    assert.equal(changed.quote.deliveryGuidance, "Test guidance B");
    assert.equal(await db.order.count({ where: { attemptId: review.attemptId } }), 0);
    await db.checkoutAttempt.delete({ where: { id: review.attemptId } });
  } finally {
    await db.deliveryZone.deleteMany({ where: { district } });
    await db.auditEvent.deleteMany({ where: { target: `bd/${district}/standard` } });
  }
});

test("the shared database quota admits only the configured number of concurrent requests", async () => {
  const subject = randomUUID();
  const results = await Promise.all(Array.from({ length: 6 }, () => consumeQuota("launch-test", subject, 3, 60)));
  assert.equal(results.filter(Boolean).length, 3);
});

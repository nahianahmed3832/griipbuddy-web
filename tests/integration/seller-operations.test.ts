import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { handleMainAdminCatalog } from "../../src/lib/catalog/main-admin-api.ts";
import { getDb } from "../../src/lib/db/client.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";
import { sellerMarketProfile, saveSellerMarketProfile, sellerVerificationQueue, saveSellerVerification, SellerProfileError } from "../../src/lib/marketplace/seller-market-profile.ts";

requireLocalDatabase("griipbuddy_test");
const db = getDb();
after(() => db.$disconnect());

test("seller settings and signed Admin operations preserve shop, market, permission and version boundaries", async t => {
  const previous = new Map<string, string | undefined>();
  function configure(values: Record<string, string>) {
    for (const [name, value] of Object.entries(values)) {
      if (!previous.has(name)) previous.set(name, process.env[name]);
      process.env[name] = value;
    }
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const owner = { id: randomUUID(), role: "OWNER", legacy: randomBytes(12).toString("hex") } as const;
  const packer = { id: randomUUID(), role: "PACKER", legacy: randomBytes(12).toString("hex") } as const;
  const secret = randomBytes(48).toString("hex");
  configure({ GRIIP_MARKETPLACE_PREVIEW: "1", GRIIP_SELLER_VERIFICATION_TEST: "1",
    GRIIP_MAIN_ADMIN_CATALOG_SECRET: secret, GRIIP_MAIN_ADMIN_CATALOG_ORIGIN: "http://127.0.0.1:4361",
    GRIIP_MAIN_ADMIN_CATALOG_ACTORS: JSON.stringify({ [owner.legacy]: owner.id, [packer.legacy]: packer.id }) });
  for (const actor of [owner, packer]) await db.user.create({ data: {
    id: actor.id, name: actor.role, email: `${actor.id}@example.invalid`, staff: { create: { role: actor.role } },
  } });
  const [seller, foreign] = await Promise.all([0, 1].map(async index => {
    const id = randomUUID();
    await db.shopper.create({ data: { id, name: `Synthetic seller ${index}`, email: `${id}@example.invalid` } });
    const shop = await db.marketplaceShop.create({ data: { ownerId: id, slug: `operations-${id}`, name: `Fixture shop ${index}`, announcement: "",
      about: "Previous shop description", published: true, marketGrants: { create: [
        { marketId: "bd", status: "APPROVED" }, { marketId: "us", status: "APPROVED" },
      ] } }, select: { id: true } });
    return { id, shopId: shop.id };
  }));

  const original = await sellerMarketProfile(seller.id, "bd");
  assert.equal(original?.baseline?.about, "Previous shop description");
  const save = { action: "profile.save", key: randomUUID(), shopId: seller.shopId, revision: 0, about: "Bangladesh fixture storefront",
    announcement: "Fixture availability notice", locale: "en-BD", presentation: "compact" };
  const requests = await Promise.all([saveSellerMarketProfile(seller.id, "bd", save), saveSellerMarketProfile(seller.id, "bd", save)]);
  assert.deepEqual(requests.map(result => result.replayed).sort(), [false, true]);
  assert.equal((await sellerMarketProfile(seller.id, "bd"))?.profile?.about, save.about);
  assert.equal((await sellerMarketProfile(seller.id, "us"))?.profile, null);
  await assert.rejects(saveSellerMarketProfile(seller.id, "us", save), error => error instanceof SellerProfileError && error.status === 409);
  await assert.rejects(saveSellerMarketProfile(foreign.id, "bd", { ...save, key: randomUUID() }),
    error => error instanceof SellerProfileError && error.status === 404);
  const address = await saveSellerMarketProfile(seller.id, "bd", { action: "address.save", key: randomUUID(), shopId: seller.shopId,
    revision: 0, purpose: "returns", line: "Fixture depot", city: "Dhaka", region: "Dhaka", postal: "" });
  await assert.rejects(saveSellerMarketProfile(seller.id, "us", { action: "address.archive", key: randomUUID(), shopId: seller.shopId,
    revision: 1, id: address.id }), error => error instanceof SellerProfileError && error.status === 404);
  assert.equal((await sellerMarketProfile(seller.id, "bd"))?.addresses.length, 1);
  assert.equal((await sellerMarketProfile(foreign.id, "bd"))?.addresses.length, 0);

  async function signed(request: object, expected = 200, marketId = "bd", actor: typeof owner | typeof packer = owner) {
    const body = JSON.stringify({ request, marketId, central: actor.role === "OWNER", issuedAt: Date.now(), nonce: randomUUID(), legacyId: actor.legacy });
    const signature = createHmac("sha256", secret).update("griip-main-admin-catalog-v1\n").update(body).digest("hex");
    const response = await handleMainAdminCatalog(new Request("http://127.0.0.1:3100/api/internal/main-admin-catalog", {
      method: "POST", headers: { "content-type": "application/json", "x-griip-catalog-signature": signature }, body,
    }));
    const payload = await response.json();
    assert.equal(response.status, expected, JSON.stringify(payload));
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    return payload.data;
  }

  const forms = await signed({ read: "seller-verification" });
  await signed({ read: "seller-verification" }, 403, "bd", packer);
  const form = { action: "verification.form", key: randomUUID(), previousVersion: forms.form?.version ?? 0, fields: ["businessName", "website"] };
  const publish = await signed({ action: "seller-verification.command", input: form });
  assert.equal(Number(publish.id), form.previousVersion + 1);
  await assert.rejects(saveSellerVerification(packer.id, "bd", { ...form, key: randomUUID() }),
    error => error instanceof SellerProfileError && error.status === 403);
  const submission = { action: "verification.submit", key: randomUUID(), shopId: seller.shopId, version: Number(publish.id),
    answers: { businessName: "Fixture shop", website: "https://example.invalid/" } };
  await assert.rejects(saveSellerMarketProfile(seller.id, "bd", { ...submission, answers: { ...submission.answers, website: "https://u:p@example.invalid/" } }),
    error => error instanceof SellerProfileError && error.status === 422);
  const saved = await saveSellerMarketProfile(seller.id, "bd", submission);
  const review = { action: "verification.review", key: randomUUID(), id: saved.id, decision: "ACCEPTED", note: "Fixture form reviewed" };
  await signed({ action: "seller-verification.command", input: review }, 409, "us");
  await signed({ action: "seller-verification.command", input: review });
  assert.equal((await sellerVerificationQueue(owner.id, "bd")).rows.find(row => row.id === saved.id)?.state, "ACCEPTED");
  assert.equal((await sellerMarketProfile(seller.id, "bd"))?.submission?.state, "ACCEPTED");
  configure({ GRIIP_SELLER_VERIFICATION_TEST: "0" });
  await signed({ read: "seller-verification" }, 403);
  assert.equal((await sellerMarketProfile(seller.id, "bd"))?.submission, null);

  const notice = { action: "notice.publish", operationId: randomUUID(), scope: "SHOP", shopId: seller.shopId,
    title: "Fixture seller notice", body: "This is a scoped notice for the Bangladesh organization fixture." };
  await signed({ action: "seller-hub.command", input: notice }, 403, "bd", packer);
  const { id } = await signed({ action: "seller-hub.command", input: notice });
  assert.equal((await signed({ action: "seller-hub.command", input: notice })).id, id);
  const local = await signed({ read: "seller-hub", section: "notices", id });
  assert.equal(local.detail.id, id);
  const overseas = await signed({ read: "seller-hub", section: "notices", id }, 200, "us");
  assert.equal(overseas.detail, null);
  await signed({ read: "seller-hub", section: "notices" }, 403, "bd", packer);
});

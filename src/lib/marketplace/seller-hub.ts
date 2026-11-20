import { createHash } from "node:crypto";
import type { MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import type { SellerHubKind } from "../../generated/prisma/enums.ts";
import { uuid } from "../commerce/checkout-types.ts";
import { getDb } from "../db/client.ts";
import { activeSellerMarket, getSellerAccess, lockSellerScope } from "./seller-access.ts";
import { adminHubInput, sellerHubInput } from "./seller-hub-input.ts";

export class SellerHubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const sectionKinds = {
  notices: "NOTICE", requests: "REQUEST", campaigns: "CAMPAIGN", conversations: "CONVERSATION",
} as const satisfies Record<string, SellerHubKind>;
export const hubSections = Object.keys(sectionKinds) as HubSection[];
export type HubSection = keyof typeof sectionKinds;

type Db = Prisma.TransactionClient;
type SellerViewer = { shopId: string; shopperId: string; marketId: MarketId };
type StaffOwner = { id: string; role: "owner" | "OWNER" };

function sellerRecords(shopId: string, marketId: MarketId): Prisma.SellerHubRecordWhereInput {
  return { OR: [{ kind: "NOTICE", shopId: null, marketId: null }, { kind: "NOTICE", shopId: null, marketId }, { shopId, marketId }] };
}

function recordSelect(viewer?: SellerViewer, detail?: boolean) {
  return {
    id: true, kind: true, marketId: true, shopId: true, shop: { select: { name: true } },
    title: true, body: true, category: true, reference: true, status: true, createdAt: true, updatedAt: true,
    posts: { take: detail ? 50 : 1, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, from: true, text: true, createdAt: true } },
    reads: { where: viewer ? { shopperId: viewer.shopperId, shopId: viewer.shopId, marketId: viewer.marketId } : { shopperId: "" },
      take: 1, select: { seenAt: true, acknowledgedAt: true } },
  } satisfies Prisma.SellerHubRecordSelect;
}

function recordView(row: Prisma.SellerHubRecordGetPayload<{select: ReturnType<typeof recordSelect>}>) {
  const { shop, reads: [read], posts, ...fields } = row;
  return { ...fields, shopName: shop?.name ?? null,
    scope: row.shopId ? "SHOP" as const : row.marketId ? "MARKET" as const : "PLATFORM" as const,
    posts: [...posts].reverse(), seen: Boolean(read && read.seenAt >= row.updatedAt),
    acknowledged: Boolean(read?.acknowledgedAt), response: row.status === "OPEN" ? null : row.status };
}
export type HubRecordView = ReturnType<typeof recordView>;

async function page(where: Prisma.SellerHubRecordWhereInput, pageNo: number, viewer?: SellerViewer) {
  const pageSize = 20;
  const skip = (Math.min(10_000, Math.max(1, Number.isInteger(pageNo) ? pageNo : 1)) - 1) * pageSize;
  const rows = await getDb().sellerHubRecord.findMany({ where, skip, take: pageSize + 1,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }], select: recordSelect(viewer) });
  return { rows: rows.slice(0, pageSize).map(recordView), hasNext: rows.length > pageSize };
}

async function detail(id: string, where: Prisma.SellerHubRecordWhereInput, viewer?: SellerViewer) {
  if (!uuid.safeParse(id).success) return null;
  const row = await getDb().sellerHubRecord.findFirst({ where: { id, ...where }, select: recordSelect(viewer, true) });
  return row ? recordView(row) : null;
}

export function adminHubPage(marketId: MarketId, section: HubSection, pageNo = 1) {
  return page({ kind: sectionKinds[section], OR: [{ marketId }, { kind: "NOTICE", marketId: null }] }, pageNo);
}

export function adminHubDetail(marketId: MarketId, id: string) {
  return detail(id, { OR: [{ marketId }, { kind: "NOTICE", marketId: null }] });
}

export async function sellerHubPage(viewer: SellerViewer, section: HubSection, pageNo = 1) {
  if (!await getSellerAccess(viewer.shopperId, viewer.shopId, viewer.marketId, "SUPPORT")) throw new SellerHubError(404, "Seller Hub is unavailable for this market.");
  return page({ kind: sectionKinds[section], ...sellerRecords(viewer.shopId, viewer.marketId) }, pageNo, viewer);
}

export async function sellerHubDetail(viewer: SellerViewer, id: string) {
  if (!await getSellerAccess(viewer.shopperId, viewer.shopId, viewer.marketId, "SUPPORT")) throw new SellerHubError(404, "Seller Hub is unavailable for this market.");
  return detail(id, sellerRecords(viewer.shopId, viewer.marketId), viewer);
}

export async function applySellerOperation(db: Db, actorKey: string, operationId: string, scope: unknown, action: string,
  write: () => Promise<string>) {
  const fingerprint = createHash("sha256").update(JSON.stringify({ scope, action })).digest("hex");
  await db.$queryRaw`SELECT true FROM pg_advisory_xact_lock(hashtextextended(${actorKey + ":" + operationId}, 0))`;
  const key = { actorKey, operationId };
  const old = await db.sellerHubOperation.findUnique({ where: { actorKey_operationId: key } });
  if (old) {
    if (old.fingerprint !== fingerprint) throw new SellerHubError(409, "Refresh before submitting a changed request.");
    return { id: old.resourceId };
  }
  const id = await write();
  await db.sellerHubOperation.create({ data: { ...key, action, fingerprint, resourceId: id } });
  return { id };
}

async function staffOwner(db: Db, actor: StaffOwner) {
  await db.$queryRaw`SELECT "userId" FROM "StaffAccess" WHERE "userId" = ${actor.id} FOR SHARE`;
  if (!await db.staffAccess.findFirst({ where: { userId: actor.id, role: "OWNER", active: true }, select: { userId: true } })) {
    throw new SellerHubError(403, "Owner access is required.");
  }
}

async function approvedShop(db: Db, shopId: string, marketId: MarketId) {
  await lockSellerScope(db, shopId, marketId);
  if (!await db.marketplaceShop.findFirst({ where: { AND: [{ id: shopId }, activeSellerMarket(marketId)] }, select: { id: true } })) {
    throw new SellerHubError(404, "That seller is unavailable in this market.");
  }
}

async function campaignEligible(db: Db, code: string, shopId: string, marketId: MarketId) {
  await db.$queryRaw`SELECT code FROM "MarketplaceCoupon" WHERE code = ${code} FOR SHARE`;
  if (!await db.marketplaceCoupon.findFirst({
    where: { code, marketId, enabled: true, AND: [{ OR: [{ shopId: null }, { shopId }] },
      { OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] }] }, select: { code: true },
  })) throw new SellerHubError(409, "This campaign is unavailable for the selected shop and market.");
}

async function lockedRecord(db: Db, id: string, where: Prisma.SellerHubRecordWhereInput) {
  await db.$queryRaw`SELECT id FROM "SellerHubRecord" WHERE id = ${id}::uuid FOR UPDATE`;
  const row = await db.sellerHubRecord.findFirst({ where: { id, ...where },
    select: { id: true, kind: true, status: true, shopId: true, reference: true } });
  if (!row) throw new SellerHubError(404, "That record is unavailable.");
  return row;
}

async function appendPost(db: Db, id: string, from: "STAFF" | "SELLER", text: string) {
  await db.sellerHubPost.create({ data: { recordId: id, from, text } });
  await db.sellerHubRecord.update({ where: { id }, data: { updatedAt: new Date() } });
}

async function audit(db: Db, id: string, actorId: string, source: "staff" | "seller", marketId: MarketId,
  action: string, operationId: string, shopId?: string | null) {
  await db.auditEvent.create({ data: {
    action: "SELLER_HUB_CHANGED", target: id, ...(source === "staff" && { actorId }),
    changes: { marketId, shopId: shopId ?? null, actor: { kind: source, id: actorId }, action, operationId },
  } });
}

export async function runAdminHubCommand(actor: StaffOwner, marketId: MarketId, raw: unknown) {
  const parsed = adminHubInput.safeParse(raw);
  if (!parsed.success) throw new SellerHubError(400, "Check the Hub action and its details.");
  const command = parsed.data;
  return getDb().$transaction(async db => {
    await staffOwner(db, actor);
    return applySellerOperation(db, "staff:" + actor.id, command.operationId, { marketId, command }, command.action, async () => {
      const { action } = command;
      let record: { id: string; shopId: string | null };
      if (action === "notice.publish") {
        const shopId = command.scope === "SHOP" ? command.shopId : null;
        if (shopId) await approvedShop(db, shopId, marketId);
        record = await db.sellerHubRecord.create({ data: { kind: "NOTICE", shopId,
          marketId: command.scope === "PLATFORM" ? null : marketId, title: command.title, body: command.body },
          select: { id: true, shopId: true } });
      } else if (action === "campaign.invite") {
        await approvedShop(db, command.shopId, marketId);
        await campaignEligible(db, command.reference, command.shopId, marketId);
        if (await db.sellerHubRecord.findUnique({ where: {
          shopId_marketId_reference: { shopId: command.shopId, marketId, reference: command.reference },
        }, select: { id: true } })) throw new SellerHubError(409, "This shop already has an invitation for the campaign.");
        record = await db.sellerHubRecord.create({ data: { kind: "CAMPAIGN", shopId: command.shopId, marketId, title: command.title,
          body: command.body, reference: command.reference }, select: { id: true, shopId: true } });
      } else if (action === "conversation.start") {
        await approvedShop(db, command.shopId, marketId);
        record = await db.sellerHubRecord.create({ data: { kind: "CONVERSATION", shopId: command.shopId, marketId,
          title: command.title, body: "", posts: { create: { from: "STAFF", text: command.text } } },
          select: { id: true, shopId: true } });
      } else if (action === "request.review") {
        record = await lockedRecord(db, command.id, { kind: "REQUEST", marketId });
        const updated = await db.sellerHubRecord.updateMany({ where: { id: record.id, status: "OPEN" }, data: { status: command.decision } });
        if (!updated.count) throw new SellerHubError(409, "This request already has a decision.");
        await appendPost(db, record.id, "STAFF", command.note);
      } else {
        // Lock the shop before the thread to match the seller reply sequence.
        const target = await db.sellerHubRecord.findFirst({ where: { id: command.id, marketId, kind: "CONVERSATION" }, select: { shopId: true } });
        if (!target?.shopId) throw new SellerHubError(404, "That conversation is unavailable.");
        await approvedShop(db, target.shopId, marketId);
        record = await lockedRecord(db, command.id, { kind: "CONVERSATION", marketId, shopId: target.shopId });
        await appendPost(db, record.id, "STAFF", command.text);
      }
      await audit(db, record.id, actor.id, "staff", marketId, action, command.operationId, record.shopId);
      return record.id;
    });
  }).catch(uniqueConflict);
}

function uniqueConflict(error: unknown): never {
  if (typeof error === "object" && error && "code" in error && error.code === "P2002") {
    throw new SellerHubError(409, "This operation conflicts with an existing Hub record.");
  }
  throw error;
}

export async function runSellerHubCommand(shopperId: string, marketId: MarketId, raw: unknown) {
  const parsed = sellerHubInput.safeParse(raw);
  if (!parsed.success) throw new SellerHubError(400, "Check the Hub action and its details.");
  const command = parsed.data;
  const { shopId, action } = command;
  return getDb().$transaction(async db => {
    await lockSellerScope(db, shopId, marketId);
    if (!await getSellerAccess(shopperId, shopId, marketId, "SUPPORT", db)) throw new SellerHubError(404, "Seller Hub is unavailable for this market.");
    return applySellerOperation(db, "seller:" + shopperId, command.operationId, { marketId, command }, action, async () => {
      let id: string;
      if (action === "request.submit") {
        ({ id } = await db.sellerHubRecord.create({ data: { kind: "REQUEST", shopId, marketId, title: command.title,
          body: command.body, category: command.category }, select: { id: true } }));
      } else if (action === "conversation.start") {
        ({ id } = await db.sellerHubRecord.create({ data: { kind: "CONVERSATION", shopId, marketId,
          title: command.title, body: "", posts: { create: { from: "SELLER", text: command.text } } }, select: { id: true } }));
      } else if (action === "notice.acknowledge" || action === "record.read") {
        ({ id } = await lockedRecord(db, command.id, {
          ...sellerRecords(shopId, marketId), ...(action === "notice.acknowledge" && { kind: "NOTICE" }),
        }));
        const key = { recordId: id, shopId, shopperId, marketId };
        const now = new Date();
        const previous = await db.sellerHubRead.findUnique({ where: { recordId_shopId_shopperId_marketId: key }, select: { acknowledgedAt: true } });
        const dates = { seenAt: now, ...(action === "notice.acknowledge" && { acknowledgedAt: previous?.acknowledgedAt ?? now }) };
        await db.sellerHubRead.upsert({ where: { recordId_shopId_shopperId_marketId: key }, create: { ...key, ...dates }, update: dates });
      } else if (action === "conversation.reply") {
        ({ id } = await lockedRecord(db, command.id, { shopId, marketId, kind: "CONVERSATION" }));
        await appendPost(db, id, "SELLER", command.text);
      } else {
        const record = await lockedRecord(db, command.id, { shopId, marketId, kind: "CAMPAIGN" });
        if (record.status !== "OPEN" || !record.reference) throw new SellerHubError(409, "This invitation already has a response.");
        if (command.decision === "ACCEPTED") await campaignEligible(db, record.reference, shopId, marketId);
        ({ id } = await db.sellerHubRecord.update({ where: { id: record.id }, data: { status: command.decision }, select: { id: true } }));
      }
      if (action !== "record.read") await audit(db, id, shopperId, "seller", marketId, action, command.operationId, shopId);
      return id;
    });
  }).catch(uniqueConflict);
}

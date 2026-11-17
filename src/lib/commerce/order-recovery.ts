import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { localizedStoreHref, marketStoreHref } from "../../config/regional-path.ts";
import { storefrontPath } from "../../config/storefront-path.ts";
import { getDb } from "../db/client.ts";
import { isOperatingDatabase } from "../db/local.ts";
import { hybridDemoMode, marketplaceMode } from "../release-config.ts";
import { uuid } from "./checkout-types.ts";
import { equalDigest, requestDigest } from "./guest.ts";

export const receiptAccessCookie = "griipbuddy-order-access";
export const orderLinkLifetime = 7 * 86_400;
export const receiptAccessLifetime = 86_400;
export const orderRecoveryToken = z.string().regex(/^v1\.\d{10}\.[a-f0-9]{64}$/);

type Credential = "link" | "receipt";
type Proof = { id: string; guestKey: string };

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function sign(kind: Credential, { id, guestKey }: Proof, expires: number) {
  return requestDigest(JSON.stringify(["guest-order-recovery", "v1", kind, id, guestKey, expires]));
}

export function orderRecoveryCredential(kind: Credential, proof: Proof, expires: number) {
  return `v1.${expires}.${sign(kind, proof, expires)}`;
}

export function orderRecoveryExpiry(kind: Credential, proof: Proof, token: unknown, now = nowSeconds()) {
  const parsed = orderRecoveryToken.safeParse(token);
  if (!parsed.success) return null;
  const [, timestamp, mac] = parsed.data.split(".");
  const expires = Number(timestamp);
  return expires > now && equalDigest(mac, sign(kind, proof, expires)) ? expires : null;
}

export function orderRecoveryEnabled() {
  return marketplaceMode() && isOperatingDatabase();
}

export function orderRecoveryPaths(id: string, market: MarketId, regional = hybridDemoMode()) {
  const region = regional ? market : undefined;
  const receipt = `/orders/${id}`;
  return {
    claim: storefrontPath(marketStoreHref(`/orders/recover/${id}`, region)),
    receipt: storefrontPath(marketStoreHref(receipt, region)),
    cookiePath: storefrontPath(localizedStoreHref(receipt, region)),
  };
}

async function guestOrderProof(id: string, guestKey?: string, marketId?: MarketId) {
  if (!uuid.safeParse(id).success) return null;
  const order = await getDb().order.findFirst({
    where: { id, marketId, shopperId: null, ...(guestKey ? { attempt: { guestKey } } : {}) },
    select: { id: true, marketId: true, attempt: { select: { guestKey: true } } },
  });
  return order && { id: order.id, market: order.marketId, guestKey: order.attempt.guestKey };
}

export async function createGuestOrderLink(id: string, guestKey: string, marketId?: MarketId) {
  const proof = await guestOrderProof(id, guestKey, marketId);
  if (!proof) return null;
  const expires = nowSeconds() + orderLinkLifetime;
  const token = orderRecoveryCredential("link", proof, expires);
  const path = orderRecoveryPaths(proof.id, proof.market).claim;
  return { path: `${path}#access=${token}`, expiresAt: new Date(expires * 1000).toISOString() };
}

export async function redeemGuestOrderLink(id: string, token: string, marketId?: MarketId) {
  const proof = await guestOrderProof(id, undefined, marketId);
  if (!proof) return null;
  const now = nowSeconds();
  const expires = orderRecoveryExpiry("link", proof, token, now);
  if (!expires) return null;
  const maxAge = Math.min(receiptAccessLifetime, expires - now);
  return { ...orderRecoveryPaths(proof.id, proof.market), maxAge, cookie: orderRecoveryCredential("receipt", proof, now + maxAge) };
}

export async function recoveredReceiptGuestKey(id: string, token: string | undefined, marketId?: MarketId) {
  if (!orderRecoveryToken.safeParse(token).success) return null;
  const proof = await guestOrderProof(id, undefined, marketId);
  return proof && orderRecoveryExpiry("receipt", proof, token) ? proof.guestKey : null;
}

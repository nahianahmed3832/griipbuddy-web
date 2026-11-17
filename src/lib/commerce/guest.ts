import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const guestCookie = "griipbuddy-guest";
export const guestMaxAge = 30 * 24 * 60 * 60;

function checkoutSecret(): string {
  const secret = process.env.CHECKOUT_SECRET;
  if (!secret || secret.length < 32) throw new Error("Set CHECKOUT_SECRET to an independent random secret of at least 32 characters.");
  return secret;
}

function digest(scope: string, value: string): string {
  return createHmac("sha256", checkoutSecret()).update(scope).update("\0").update(value).digest("hex");
}

export function newGuestToken(): string {
  const token = randomBytes(32).toString("hex");
  const expires = Math.floor(Date.now() / 1000) + guestMaxAge;
  const payload = `${token}.${expires}`;
  return `${payload}.${digest("guest", payload)}`;
}

export function readGuestKey(value: string | undefined): string | null {
  if (!value || !/^[a-f0-9]{64}\.\d{10}\.[a-f0-9]{64}$/.test(value)) return null;
  const [token, expires, signature] = value.split(".");
  if (Number(expires) <= Math.floor(Date.now() / 1000)) return null;
  if (!equalDigest(signature, digest("guest", `${token}.${expires}`))) return null;
  return createHash("sha256").update(token).digest("hex");
}

export function requestDigest(data: string) {
  return digest("checkout-request", data);
}

export function quoteDigest(data: string) {
  return digest("checkout-review", data);
}

export function equalDigest(left: string, right: string): boolean {
  return /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

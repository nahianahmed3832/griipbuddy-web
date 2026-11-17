import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { verifyJWT, verifyPassword } from "better-auth/crypto";
import { headers } from "next/headers";
import { cache } from "react";
import { z } from "zod";
import { marketDirectory, type MarketId } from "../../config/markets.ts";
import { marketStoreHref } from "../../config/regional-path.ts";
import { storefrontCookiePath, storefrontPath } from "../../config/storefront-path.ts";
import { sendShopperAccountMail, shopperMailSupports } from "../commerce/shopper-mail.ts";
import { getDb } from "../db/client.ts";
import { secureCookies } from "../db/http.ts";
import { demoSellerOrigin, fixtureMarketEnabled, hybridDemoMode, marketplaceMode } from "../release-config.ts";
import type { AccountLanguage } from "./account-language.ts";
import { storefrontHandoffPlugin } from "./identity-handoff.ts";
import { demoEmail, shopperPhonePlugin } from "./phone.ts";

type AccountMailKind = "verify" | "reset";

function shopperAuthConfig() {
  const baseURL = process.env.BETTER_AUTH_URL;
  const secret = process.env.SHOPPER_AUTH_SECRET;
  if (!baseURL || !secret || secret.length < 32) throw new Error("Shopper sign-in requires its own secret and origin");
  return { baseURL, secret };
}

export function shopperMailReturn(kind: AccountMailKind, region: MarketId, language: AccountLanguage = "en") {
  const { baseURL } = shopperAuthConfig();
  const path = kind === "verify" ? "/account/verify-email" : "/account/reset-password";
  const link = new URL(storefrontPath(marketStoreHref(path, region)), baseURL);
  if (region === "bd" && language === "bn") link.searchParams.set("language", "bn");
  return link.href;
}

function isProtectedEmail(email: string) {
  return email === demoEmail || email.endsWith("@phone.griipbuddy.invalid");
}

async function dispatchAccountMail(kind: AccountMailKind, detail: { user: { email: string }; url: string; token: string }) {
  const email = detail.user.email.toLowerCase();
  if (isProtectedEmail(email) || !shopperMailSupports(email)) return;
  const { baseURL } = shopperAuthConfig();
  const source = new URL(detail.url, baseURL);
  const callback = source.searchParams.get("callbackURL");
  const allowed = marketDirectory(fixtureMarketEnabled()).flatMap(({ id, languages }) => languages.map(language => shopperMailReturn(kind, id, language)));
  if (!callback || !allowed.includes(callback)) throw new Error("Shopper mail requires a storefront account callback");
  const link = new URL(callback, baseURL);
  link.hash = new URLSearchParams({ token: detail.token }).toString();
  await sendShopperAccountMail({ kind, email, url: link.href, language: link.searchParams.get("language") === "bn" ? "bn" : "en" });
}

const verificationClaims = z.object({
  userId: z.string().min(1), email: z.email(), exp: z.number().int(), updateTo: z.undefined().optional(), requestType: z.undefined().optional(),
});

export async function verifyShopperLinkPassword(token: string, password: string) {
  const { secret } = shopperAuthConfig();
  const parsed = verificationClaims.safeParse(await verifyJWT(token, secret));
  if (!parsed.success || isProtectedEmail(parsed.data.email)) return "INVALID_TOKEN";
  const { userId, email } = parsed.data;
  const credential = await getDb().shopperIdentity.findFirst({
    where: { userId, accountId: userId, providerId: "credential", user: { email } },
    select: { password: true },
  });
  if (!credential?.password) return "INVALID_TOKEN";
  return await verifyPassword({ hash: credential.password, password }) ? null : "INVALID_PASSWORD";
}

export async function canResetShopperEmail(email: string) {
  if (isProtectedEmail(email)) return false;
  const user = await getDb().shopper.findUnique({
    where: { email },
    select: { id: true, accounts: { where: { providerId: "credential", password: { not: null } }, select: { accountId: true } } },
  });
  return user?.accounts.some(account => account.accountId === user.id) ?? false;
}

export async function canResetShopperToken(token: string) {
  const db = getDb();
  const verification = await db.shopperVerification.findFirst({
    where: { identifier: `reset-password:${token}`, expiresAt: { gt: new Date() } },
    select: { value: true }, orderBy: { createdAt: "desc" },
  });
  if (!verification) return false;
  const shopper = await db.shopper.findUnique({ where: { id: verification.value }, select: { email: true } });
  return shopper ? canResetShopperEmail(shopper.email) : false;
}

function createAuth() {
  const { baseURL, secret } = shopperAuthConfig();
  const demo = hybridDemoMode();
  return betterAuth({
    baseURL, basePath: storefrontPath("/api/shopper-auth"), secret,
    ...(demo && { trustedOrigins: [demoSellerOrigin] }),
    database: prismaAdapter(getDb(), { provider: "postgresql", transaction: true }),
    user: { modelName: "shopper" },
    session: { modelName: "shopperSession", expiresIn: 30 * 86400, updateAge: 86400 },
    account: { modelName: "shopperIdentity" },
    verification: { modelName: "shopperVerification" },
    emailAndPassword: {
      enabled: true, minPasswordLength: demo ? 8 : 10, maxPasswordLength: 128, autoSignIn: false,
      ...(demo && {
        requireEmailVerification: true,
        resetPasswordTokenExpiresIn: 30 * 60,
        revokeSessionsOnPasswordReset: true,
        sendResetPassword: (detail) => dispatchAccountMail("reset", detail),
        async onPasswordReset({ user }) {
          if (!isProtectedEmail(user.email)) {
            await getDb().shopper.updateMany({ where: { id: user.id, email: user.email, emailVerified: false }, data: { emailVerified: true } });
          }
        },
      }),
    },
    ...(demo && {
      emailVerification: {
        sendOnSignUp: true, sendOnSignIn: false, autoSignInAfterVerification: false, expiresIn: 60 * 60,
        sendVerificationEmail: (detail) => dispatchAccountMail("verify", detail),
        async beforeEmailVerification(user) {
          // Old preview sessions were created before verification was required.
          await getDb().shopperSession.deleteMany({ where: { userId: user.id } });
        },
      },
    }),
    plugins: [storefrontHandoffPlugin(), ...(demo ? [shopperPhonePlugin(secret)] : [])],
    rateLimit: { enabled: true, storage: "database", customRules: {
      "/sign-up/email": { window: 3600, max: 12 }, "/sign-in/email": { window: 120, max: 12 },
    } },
    advanced: {
      cookiePrefix: demo ? "griipbuddy-demo-shopper" : "griipbuddy-shopper", useSecureCookies: secureCookies(),
      defaultCookieAttributes: { path: storefrontCookiePath },
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    telemetry: { enabled: false }, logger: { disabled: true },
  });
}

let auth: ReturnType<typeof createAuth> | undefined;

export function shopperAuth() {
  if (!marketplaceMode()) throw new Error("Shopper sign-in is unavailable");
  return auth ??= createAuth();
}

export const getShopperSession = cache(async () => {
  if (!marketplaceMode()) return null;
  const session = await shopperAuth().api.getSession({ headers: await headers() });
  const user = session?.user;
  if (!user || hybridDemoMode() && !user.emailVerified && !("phoneNumberVerified" in user && user.phoneNumberVerified === true)) return null;
  return session;
});

export const getShopper = cache(async () => (await getShopperSession())?.user ?? null);

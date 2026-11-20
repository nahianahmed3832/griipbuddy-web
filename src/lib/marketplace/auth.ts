import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { headers } from "next/headers";
import { cache } from "react";
import { storefrontCookiePath, storefrontPath } from "../../config/storefront-path.ts";
import { getDb } from "../db/client.ts";
import { secureCookies } from "../db/http.ts";
import { hybridDemoMode, marketplaceMode } from "../release-config.ts";
import { shopperPhonePlugin } from "./phone.ts";

function createAuth() {
  const baseURL = process.env.BETTER_AUTH_URL;
  const secret = process.env.SHOPPER_AUTH_SECRET;
  if (!baseURL || !secret || secret.length < 32) throw new Error("Shopper sign-in requires its own secret and origin");
  const demo = hybridDemoMode();
  return betterAuth({
    baseURL, basePath: storefrontPath("/api/shopper-auth"), secret,
    database: prismaAdapter(getDb(), { provider: "postgresql", transaction: true }),
    user: { modelName: "shopper" },
    session: { modelName: "shopperSession", expiresIn: 30 * 86400, updateAge: 86400 },
    account: { modelName: "shopperIdentity" },
    verification: { modelName: "shopperVerification" },
    emailAndPassword: { enabled: true, minPasswordLength: demo ? 8 : 10, maxPasswordLength: 128, autoSignIn: false },
    plugins: demo ? [shopperPhonePlugin(secret)] : [],
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

export const getShopper = cache(async () => {
  if (!marketplaceMode()) return null;
  const session = await shopperAuth().api.getSession({ headers: await headers() });
  return session?.user ?? null;
});

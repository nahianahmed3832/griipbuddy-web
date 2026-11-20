import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { getDb } from "../db/client.ts";
import { secureCookies } from "../db/http.ts";
import { storefrontCookiePath, storefrontPath } from "../../config/storefront-path.ts";
import { hybridDemoMode } from "../release-config.ts";

let auth: ReturnType<typeof createStaffAuth> | undefined;

function createStaffAuth() {
  const baseURL = process.env.BETTER_AUTH_URL;
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!baseURL || !secret || secret.length < 32) throw new Error("Configure BETTER_AUTH_URL and a random BETTER_AUTH_SECRET.");
  const demo = hybridDemoMode();
  return betterAuth({
    baseURL,
    basePath: storefrontPath("/api/staff"),
    secret,
    database: prismaAdapter(getDb(), { provider: "postgresql" }),
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: demo ? 8 : 14, maxPasswordLength: 128 },
    session: { expiresIn: 8 * 60 * 60, disableSessionRefresh: true },
    databaseHooks: {
      session: { create: { before: async (session) => {
        const access = await getDb().staffAccess.findUnique({ where: { userId: session.userId } });
        return Boolean(access?.active);
      } } },
    },
    rateLimit: { enabled: true, storage: "database", customRules: { "/sign-in/email": { window: 60, max: 12 } } },
    advanced: {
      cookiePrefix: demo ? "griipbuddy-demo-admin" : storefrontCookiePath === "/" ? "griipbuddy-staff" : "griipbuddy-release-staff",
      useSecureCookies: secureCookies(), defaultCookieAttributes: { path: storefrontCookiePath },
    },
    logger: { disabled: true },
    telemetry: { enabled: false },
  });
}

export function staffAuth() {
  return auth ??= createStaffAuth();
}

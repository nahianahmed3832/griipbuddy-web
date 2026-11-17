import { after } from "next/server";
import { z } from "zod";
import { isStorefrontMarketId, marketIds } from "@/config/markets";
import { currentAccountLanguage } from "@/lib/marketplace/account-language-server";
import { currentMarket } from "@/lib/market-server";
import { canResetShopperEmail, canResetShopperToken, getShopper, shopperAuth, shopperMailReturn, verifyShopperLinkPassword } from "@/lib/marketplace/auth";
import { fixtureMarketEnabled, hybridDemoMode, marketplaceMode } from "@/lib/release-config";
import { shopperMailAvailable, shopperMailSupports } from "@/lib/commerce/shopper-mail";
import { demoEmail, demoPhone, demoPhoneConfigured, phoneCanAuthenticate, validPhoneNumber } from "@/lib/marketplace/phone";
import { privateHeaders, readJson, sameOrigin } from "@/lib/db/http";
import { clientKey, consumeQuota, reportFailure } from "@/lib/db/observability";
import { storefrontPath } from "@/config/storefront-path";

const email = z.email().max(254).transform(value => value.toLowerCase());
const password = z.string().min(8).max(128);
const credentials = z.object({ email, password });
const phone = z.string().regex(validPhoneNumber);
const region = z.enum(marketIds).optional();
const verifyToken = z.string().max(2048).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
const resetToken = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
const requests = {
  "sign-up/email": credentials.extend({ name: z.string().trim().min(2).max(65), region }).strict(),
  "sign-in/email": credentials.extend({ rememberMe: z.boolean().optional() }).strict(),
  "sign-out": z.object({}).strict(),
  "update-user": z.object({ name: z.string().trim().min(2).max(65) }).strict(),
  "change-password": z.object({ currentPassword: z.string().min(10).max(128), newPassword: z.string().min(10).max(128),
    revokeOtherSessions: z.literal(true) }).strict(),
  "phone-number/send-otp": z.object({ phoneNumber: phone }).strict(),
  "phone-number/verify": z.object({ phoneNumber: phone, code: z.string().regex(/^\d{6}$/) }).strict(),
  "send-verification-email": z.object({ email, region }).strict(),
  "request-password-reset": z.object({ email, region }).strict(),
  "verify-email": z.object({ token: verifyToken, password }).strict(),
  "reset-password": z.object({ token: resetToken, newPassword: z.string().min(10).max(128) }).strict(),
};

const response = (data: object, status = 200) => Response.json(data, { status, headers: privateHeaders });
const invalidToken = () => response({ code: "INVALID_TOKEN", message: "This link is invalid, expired, or already used. Request a new link." }, 400);
const limited = () => response({ message: "Too many attempts. Try again later." }, 429);

function authRequest(path: string, headers: Headers, body?: object, token?: string) {
  const url = new URL(storefrontPath(`/api/shopper-auth/${path}`), process.env.BETTER_AUTH_URL);
  if (token) url.searchParams.set("token", token);
  const forwarded = new Headers(headers);
  forwarded.delete("content-length");
  if (token) forwarded.delete("cookie");
  return new Request(url, { method: body ? "POST" : "GET", headers: forwarded, body: body ? JSON.stringify(body) : undefined });
}

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  if (!marketplaceMode()) return new Response(null, { status: 404, headers: privateHeaders });
  if (!sameOrigin(request)) return new Response(null, { status: 403, headers: privateHeaders });
  const path = (await params).path.join("/");
  if (!Object.hasOwn(requests, path)) return new Response(null, { status: 404, headers: privateHeaders });

  const demo = hybridDemoMode();
  const sendsLink = path === "send-verification-email" || path === "request-password-reset";
  const consumesLink = path === "verify-email" || path === "reset-password";
  if ((sendsLink || consumesLink) && !demo) return new Response(null, { status: 404, headers: privateHeaders });
  const parsed = requests[path as keyof typeof requests].safeParse(await readJson(request, 4096));
  if (!parsed.success) {
    if (consumesLink && parsed.error.issues.some(issue => issue.path[0] === "token")) return invalidToken();
    return response({ message: "Check your details and try again." }, 400);
  }

  try {
    const data = parsed.data;
    const ip = clientKey(request.headers);
    const phoneNumber = "phoneNumber" in data ? data.phoneNumber : undefined;
    if (phoneNumber && (!demo || !phoneCanAuthenticate(phoneNumber))) {
      return response({ message: "SMS is unavailable for this number in the preview." }, 422);
    }
    if (phoneNumber && (!await consumeQuota(path, ip, 12, 300) || !await consumeQuota(path, phoneNumber, 6, 300))) return limited();
    if (!demo && "password" in data && data.password.length < 10) return response({ message: "Check your details and try again." }, 400);

    const signup = path === "sign-up/email";
    if (path === "change-password" || path === "update-user") {
      const shopper = await getShopper();
      if (!shopper) return response({ message: "Sign in to continue." }, 401);
      if (demo && path === "change-password" && shopper.email === demoEmail) {
        return response({ message: "The shared demo password is fixed." }, 403);
      }
    }

    const registration = signup && "name" in data && "email" in data && "password" in data
      ? { name: data.name, email: data.email, password: data.password } : undefined;
    let body: object = registration ?? data;
    if (demo && (signup || sendsLink) && "email" in data) {
      if (!shopperMailAvailable()) return response({ code: "EMAIL_UNAVAILABLE", message: "Account email is temporarily unavailable." }, 503);
      if (!shopperMailSupports(data.email)) return response({ code: "EMAIL_PREVIEW_ONLY", message: "Use a test address ending in @example.invalid for email in this preview." }, 422);
      if (!await consumeQuota(`shopper-mail.${path}.ip`, ip, 20, 3600) ||
          !await consumeQuota(`shopper-mail.${path}.recipient`, data.email, 5, 3600)) return limited();
      const targetRegion = ("region" in data ? data.region : undefined) ?? (await currentMarket()).id;
      if (!isStorefrontMarketId(targetRegion, fixtureMarketEnabled())) return response({ message: "This storefront is unavailable." }, 422);
      const language = await currentAccountLanguage(targetRegion);
      if (sendsLink) {
        const address = data.email;
        const reset = path === "request-password-reset";
        const target = shopperMailReturn(reset ? "reset" : "verify", targetRegion, language);
        const headers = new Headers(request.headers);
        headers.delete("cookie");
        after(async () => {
          try {
            // Do lookup and dispatch after responding so existing and unknown addresses have the same readback.
            if (await canResetShopperEmail(address)) {
              const result = await shopperAuth().handler(authRequest(path, headers, reset
                ? { email: address, redirectTo: target } : { email: address, callbackURL: target }));
              if (!result.ok && result.status !== 429) reportFailure("shopper.mail-dispatch");
            }
          } catch (error) {
            reportFailure("shopper.mail-dispatch", undefined, error);
          }
        });
        return response({ ok: true });
      }
      if (registration) body = { ...registration, callbackURL: shopperMailReturn("verify", targetRegion, language) };
    }

    const token = "token" in data ? data.token : undefined;
    if (consumesLink && token && (!await consumeQuota(`shopper-link.${path}.ip`, ip, 30, 900) ||
        !await consumeQuota(`shopper-link.${path}.token`, token, 8, 900))) return limited();

    if (path === "verify-email" && token && "password" in data) {
      const issue = await verifyShopperLinkPassword(token, data.password);
      if (issue === "INVALID_TOKEN") return invalidToken();
      if (issue === "INVALID_PASSWORD") {
        return response({ code: issue, message: "That password didn’t match. You can reset it using email." }, 401);
      }
      const result = await shopperAuth().handler(authRequest(path, request.headers, undefined, token));
      return result.ok ? response({ ok: true }) : result.status === 429 ? limited() : invalidToken();
    }
    if (path === "reset-password" && token && !await canResetShopperToken(token)) return invalidToken();

    const result = await shopperAuth().handler(authRequest(path, request.headers, body));
    if (!result.ok && path === "reset-password") return result.status === 429 ? limited() : invalidToken();
    const error = result.ok ? null : await result.json().catch(() => null) as { code?: string } | null;
    if (path === "sign-in/email" && result.status === 403 && error?.code === "EMAIL_NOT_VERIFIED") {
      return response({ code: "EMAIL_NOT_VERIFIED", message: "Verify your email before signing in." }, 403);
    }
    const exampleCode = path === "phone-number/send-otp" && phoneNumber === demoPhone && demoPhoneConfigured()
      ? process.env.SHOPPER_DEMO_PHONE_CODE : undefined;
    const outgoing = response(result.ok ? { ok: true, ...(exampleCode && { demoCode: exampleCode }),
      ...(signup && demo && { verificationRequired: true }) } : {
      message: result.status === 429 ? "Too many attempts. Try again later." : signup
        ? "We couldn't register the account. Check your details or try signing in." : "Those details couldn't be verified.",
    }, result.status);
    for (const cookie of result.headers.getSetCookie()) outgoing.headers.append("Set-Cookie", cookie);
    return outgoing;
  } catch (error) {
    reportFailure("shopper.auth", undefined, error);
    return response({ message: "Account access is temporarily unavailable." }, 503);
  }
}

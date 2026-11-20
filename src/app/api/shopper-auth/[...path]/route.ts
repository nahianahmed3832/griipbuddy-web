import { getShopper, shopperAuth } from "@/lib/marketplace/auth";
import { hybridDemoMode, marketplaceMode } from "@/lib/release-config";
import { demoEmail, demoPhone, demoPhoneConfigured, phoneCanAuthenticate, validPhoneNumber } from "@/lib/marketplace/phone";
import { privateHeaders, readJson, sameOrigin } from "@/lib/db/http";
import { clientKey, consumeQuota, reportFailure } from "@/lib/db/observability";
import { storefrontPath } from "@/config/storefront-path";
import { z } from "zod";

const credentials = z.object({ email: z.email().max(254).transform(value => value.toLowerCase()), password: z.string().min(8).max(128) });
const phone = z.string().regex(validPhoneNumber);
const requests = {
  "sign-up/email": credentials.extend({ name: z.string().trim().min(2).max(65) }).strict(),
  "sign-in/email": credentials.extend({ rememberMe: z.boolean().optional() }).strict(),
  "sign-out": z.object({}).strict(),
  "update-user": z.object({ name: z.string().trim().min(2).max(65) }).strict(),
  "change-password": z.object({ currentPassword: z.string().min(10).max(128), newPassword: z.string().min(10).max(128),
    revokeOtherSessions: z.literal(true) }).strict(),
  "phone-number/send-otp": z.object({ phoneNumber: phone }).strict(),
  "phone-number/verify": z.object({ phoneNumber: phone, code: z.string().regex(/^\d{6}$/) }).strict(),
};

export async function POST(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  if (!marketplaceMode()) return new Response(null, { status: 404 });
  if (!sameOrigin(request)) return new Response(null, { status: 403, headers: privateHeaders });
  const path = (await params).path.join("/");
  if (!Object.hasOwn(requests, path)) return new Response(null, { status: 404 });
  const parsed = requests[path as keyof typeof requests].safeParse(await readJson(request, 4096));
  if (!parsed.success) return Response.json({ message: "Check your details and try again." }, { status: 400, headers: privateHeaders });
  try {
    const demo = hybridDemoMode();
    const phoneNumber = "phoneNumber" in parsed.data ? parsed.data.phoneNumber : undefined;
    if (phoneNumber && (!demo || !phoneCanAuthenticate(phoneNumber))) {
      return Response.json({ message: "SMS is unavailable for this number in the preview." }, { status: 422, headers: privateHeaders });
    }
    if (phoneNumber && (!await consumeQuota(path, clientKey(request.headers), 12, 300) ||
      !await consumeQuota(path, phoneNumber, 6, 300))) {
      return Response.json({ message: "Too many attempts. Try again later." }, { status: 429, headers: privateHeaders });
    }
    if (!demo && "password" in parsed.data && parsed.data.password.length < 10) {
      return Response.json({ message: "Check your details and try again." }, { status: 400, headers: privateHeaders });
    }
    if (demo && path === "change-password" && (await getShopper())?.email === demoEmail) {
      return Response.json({ message: "The shared demo password is fixed." }, { status: 403, headers: privateHeaders });
    }
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    const url = new URL(storefrontPath(`/api/shopper-auth/${path}`), process.env.BETTER_AUTH_URL);
    const result = await shopperAuth().handler(new Request(url, { method: "POST", headers, body: JSON.stringify(parsed.data) }));
    const exampleCode = path === "phone-number/send-otp" && phoneNumber === demoPhone && demoPhoneConfigured()
      ? process.env.SHOPPER_DEMO_PHONE_CODE : undefined;
    const response = Response.json(result.ok ? { ok: true, ...(exampleCode && { demoCode: exampleCode }) } : {
      message: result.status === 429 ? "Too many attempts. Try again later." : path === "sign-up/email"
        ? "We couldn't register the account. Check your details or try signing in." : "Those details couldn't be verified.",
    }, { status: result.status, headers: privateHeaders });
    for (const cookie of result.headers.getSetCookie()) response.headers.append("Set-Cookie", cookie);
    return response;
  } catch (error) {
    reportFailure("shopper.auth", undefined, error);
    return Response.json({ message: "Account access is temporarily unavailable." }, { status: 503, headers: privateHeaders });
  }
}

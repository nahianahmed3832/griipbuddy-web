import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { storefrontPath } from "@/config/storefront-path";
import { marketStoreHref } from "@/config/regional-path";
import { getDb } from "@/lib/db/client";
import { privateHeaders, secureCookies } from "@/lib/db/http";
import { clientKey, consumeQuota, reportFailure } from "@/lib/db/observability";
import { getShopperSession, shopperAuth } from "@/lib/marketplace/auth";
import { accountReturnPath, identityEntryUrl, isHandoffMarket, shopperIdentityDirectory, storefrontHandoffUrl } from "@/lib/marketplace/identity-directory";
import { handoffCookie, handoffDigest, handoffMinutes, handoffToken, issueStorefrontHandoff, newHandoffToken } from "@/lib/marketplace/identity-handoff";
import { marketplaceMode } from "@/lib/release-config";

const cookiePath = storefrontPath("/api/shopper-handoff/finish");
const cookieValue = z.tuple([handoffToken, handoffToken, z.string().max(400)]);
const options = { path: cookiePath, httpOnly: true, sameSite: "lax" as const, secure: secureCookies };
const redirect = (url: URL) => NextResponse.redirect(url, { status: 303, headers: privateHeaders });

function browserState(value: string | undefined) {
  try { return cookieValue.parse(JSON.parse(Buffer.from(value ?? "", "base64url").toString("utf8"))); }
  catch { return null; }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ step: string }> }) {
  const { step } = await params;
  const directory = marketplaceMode() ? shopperIdentityDirectory() : null;
  const query = request.nextUrl.searchParams;
  const market = query.get("market");
  if (step === "readiness" && directory && directory.current === directory.issuer) {
    try {
      await shopperAuth().$context;
      await getDb().$queryRaw`SELECT 1`;
      return new Response(null, { status: 204, headers: privateHeaders });
    } catch {
      return new Response(null, { status: 503, headers: privateHeaders });
    }
  }
  if (!directory || !isHandoffMarket(market) || !["start", "authorize", "finish"].includes(step)) {
    return new Response(null, { status: 404, headers: privateHeaders });
  }
  const destination = directory.stores[market];
  if (directory.current !== (step === "authorize" ? directory.issuer : destination)) {
    return new Response(null, { status: 404, headers: privateHeaders });
  }
  const back = (path: string) => new URL(storefrontPath(marketStoreHref(accountReturnPath(path), market)), destination);
  const retry = (issue: "expired" | "unavailable", path = "/account") => {
    const url = back(path);
    url.searchParams.set("signin", issue);
    const response = redirect(url);
    response.cookies.set(handoffCookie, "", { ...options, secure: options.secure(), maxAge: 0 });
    return response;
  };
  if (step === "start") {
    const returnPath = accountReturnPath(query.get("return"));
    if (await getShopperSession().catch(() => null)) return redirect(back(returnPath));
    if (directory.issuer !== directory.current) {
      const reachable = await fetch(storefrontHandoffUrl("readiness", directory.issuer), {
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(2000),
      }).then(result => result.status === 204, () => false);
      if (!reachable) return retry("unavailable", returnPath);
    }
    const verifier = newHandoffToken();
    const state = newHandoffToken();
    const response = redirect(storefrontHandoffUrl("authorize", directory.issuer, { market, state, challenge: handoffDigest(verifier) }));
    const encoded = Buffer.from(JSON.stringify([state, verifier, returnPath])).toString("base64url");
    response.cookies.set(handoffCookie, encoded, { ...options, secure: options.secure(), maxAge: handoffMinutes * 60 });
    return response;
  }
  const state = handoffToken.safeParse(query.get("state"));
  if (!state.success) return retry("expired");
  if (step === "authorize") {
    const challenge = handoffToken.safeParse(query.get("challenge"));
    if (!challenge.success) return retry("expired");
    const intent = { market, state: state.data, challenge: challenge.data };
    try {
      const session = await getShopperSession();
      if (!session) return redirect(identityEntryUrl(directory.issuer, intent));
      if (!await consumeQuota("shopper.handoff", clientKey(request.headers), 30, 60)) {
        return redirect(identityEntryUrl(directory.issuer, { ...intent, signin: "unavailable" }));
      }
      const code = await issueStorefrontHandoff({ market, challenge: challenge.data, shopperId: session.user.id, sessionId: session.session.id });
      return redirect(storefrontHandoffUrl("finish", destination, { market, state: state.data, code }));
    } catch (error) {
      reportFailure("shopper.handoff-authorize", undefined, error);
      return redirect(identityEntryUrl(directory.issuer, { ...intent, signin: "unavailable" }));
    }
  }
  const browser = browserState(request.cookies.get(handoffCookie)?.value);
  const code = handoffToken.safeParse(query.get("code"));
  if (!browser || browser[0] !== state.data || !code.success) return retry("expired", browser?.[2]);
  try {
    const [, verifier, returnPath] = browser;
    const result = await shopperAuth().api.completeStorefrontHandoff({ body: { code: code.data, verifier, market }, headers: request.headers, asResponse: true });
    const cookies = result.headers.getSetCookie();
    if (!result.ok || !cookies.length) return retry(result.status >= 500 ? "unavailable" : "expired", returnPath);
    const response = redirect(back(returnPath));
    response.cookies.set(handoffCookie, "", { ...options, secure: options.secure(), maxAge: 0 });
    for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
    return response;
  } catch (error) {
    reportFailure("shopper.handoff-finish", undefined, error);
    return retry("unavailable", browser[2]);
  }
}

import { privateHeaders, readJson, sameOrigin } from "@/lib/db/http";
import { clientKey, consumeQuota, reportFailure } from "@/lib/db/observability";
import { shopperActor } from "@/lib/marketplace/auth";
import { configuredLegacyLink, legacyCredentials, linkLegacyAccount } from "@/lib/marketplace/legacy-account-link";

export async function POST(request: Request) {
  const fail = (code: string, message: string, status: number) =>
    Response.json({ error: { code, message } }, { status, headers: privateHeaders });
  const config = configuredLegacyLink();
  const unavailable = () => fail("unavailable", "Legacy account verification is unavailable.", 503);
  if (!config) return fail("not_found", "Legacy account verification is unavailable.", 404);
  if (!sameOrigin(request)) return fail("forbidden", "Open account verification from this storefront.", 403);
  const input = legacyCredentials.safeParse(await readJson(request, 4096));
  if (!input.success) return fail("invalid_input", "Enter the legacy account credentials.", 400);
  try {
    const shopper = await shopperActor(request.headers);
    if (!shopper) return fail("authentication_required", "Sign in to continue.", 401);
    const client = clientKey(request.headers);
    if (!await consumeQuota("legacy-link.shopper", shopper.id, 6, 600) ||
        !await consumeQuota("legacy-link.contact", input.data.phone, 12, 600) ||
        client !== "unattributed" && !await consumeQuota("legacy-link.ip", client, 24, 600)) {
      return fail("rate_limited", "Too many attempts. Try again later.", 429);
    }
    const outcome = await linkLegacyAccount(shopper, input.data, config);
    if (outcome === "linked") return Response.json({ data: { linked: true } }, { headers: privateHeaders });
    if (outcome === "conflict") return fail("conflict", "This account could not be linked. Contact support.", 409);
    if (outcome === "unverified") return fail("verification_failed", "Those details could not be verified.", 401);
    return unavailable();
  } catch (error) {
    reportFailure("shopper.legacy-link", undefined, error);
    return unavailable();
  }
}

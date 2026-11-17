import { createHash, randomBytes } from "node:crypto";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { getDb } from "../db/client.ts";
import { isHandoffMarket, shopperIdentityDirectory, type HandoffMarket } from "./identity-directory.ts";

export const handoffToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const handoffRecord = z.object({ market: z.enum(["bd", "us"]), challenge: handoffToken, shopperId: z.string(), sessionId: z.string() });
const handoffPrefix = "storefront-handoff:";
export const handoffMinutes = 5;
export const handoffCookie = "griipbuddy-account-handoff";
export const newHandoffToken = () => randomBytes(32).toString("base64url");
export const handoffDigest = (value: string) => createHash("sha256").update(value).digest("base64url");

export async function issueStorefrontHandoff(record: z.infer<typeof handoffRecord>) {
  const code = newHandoffToken();
  const db = getDb();
  const now = new Date();
  await db.$transaction([
    db.shopperVerification.deleteMany({ where: { identifier: { startsWith: handoffPrefix }, expiresAt: { lte: now } } }),
    db.shopperVerification.create({ data: { id: `${handoffPrefix}${handoffDigest(code)}`, identifier: handoffPrefix,
      value: JSON.stringify(record), expiresAt: new Date(now.getTime() + 60_000) } }),
  ]);
  return code;
}

async function consumeStorefrontHandoff(code: string, market: HandoffMarket, verifier: string) {
  const id = `${handoffPrefix}${handoffDigest(code)}`;
  return getDb().$transaction(async tx => {
    const now = new Date();
    const row = await tx.shopperVerification.findUnique({ where: { id } });
    if (!row || row.expiresAt <= now) return null;
    const parsed = handoffRecord.safeParse(JSON.parse(row.value));
    if (!parsed.success || parsed.data.market !== market || parsed.data.challenge !== handoffDigest(verifier)) return null;
    const { sessionId, shopperId } = parsed.data;
    const source = await tx.shopperSession.findFirst({ where: { id: sessionId, userId: shopperId, expiresAt: { gt: now },
      user: { OR: [{ emailVerified: true }, { phoneNumberVerified: true }] } }, select: { user: true } });
    if (!source || (await tx.shopperVerification.deleteMany({ where: { id, expiresAt: { gt: now } } })).count !== 1) return null;
    return source.user;
  });
}

export function storefrontHandoffPlugin() {
  return {
    id: "storefront-handoff",
    endpoints: {
      completeStorefrontHandoff: createAuthEndpoint("/complete-storefront-handoff", {
        method: "POST", body: z.object({ code: handoffToken, verifier: handoffToken, market: z.enum(["bd", "us"]) }),
      }, async context => {
        const { code, verifier, market } = context.body;
        const directory = shopperIdentityDirectory();
        if (!directory || !isHandoffMarket(market) || directory.current !== directory.stores[market]) throw context.error("FORBIDDEN");
        const user = await consumeStorefrontHandoff(code, market, verifier);
        if (!user) throw context.error("BAD_REQUEST");
        // The storefront gets an independent, host-only browser session.
        const session = await context.context.internalAdapter.createSession(user.id, true);
        if (!session) throw context.error("SERVICE_UNAVAILABLE");
        await setSessionCookie(context, { session, user }, true);
        return context.json({ ok: true });
      }),
    },
  };
}

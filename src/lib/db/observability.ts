import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { getDb } from "./client.ts";

export function requestId() {
  return randomUUID();
}

export function reportFailure(operation: string, reference = requestId(), error?: unknown) {
  const code = typeof error === "object" && error && "code" in error && typeof error.code === "string" &&
    /^(?:P[0-9]{4}|E[A-Z0-9]{2,15}|[0-9A-Z]{5})$/.test(error.code) ? error.code : undefined;
  console.error(JSON.stringify({ level: "error", operation, reference, code }));
}

export function clientKey(headers: Headers) {
  const trusted = process.env.TRUSTED_CLIENT_IP_HEADER;
  const ip = trusted && headers.get(trusted);
  return ip && isIP(ip) ? ip : "unattributed";
}

export async function consumeQuota(scope: string, subject: string, max: number, seconds: number) {
  const secret = process.env.CHECKOUT_SECRET;
  if (!secret || secret.length < 32) throw new Error("Missing checkout secret");
  const key = createHmac("sha256", secret).update(`${scope}:\0${subject}`).digest("hex");
  const [row] = await getDb().$queryRaw<{ hits: number }[]>`
    INSERT INTO "RequestQuota" ("key", "hits", "resetsAt") VALUES
      (${key}, 1, CURRENT_TIMESTAMP + ${seconds} * INTERVAL '1 second')
    ON CONFLICT ("key") DO UPDATE SET
      "hits" = CASE WHEN "RequestQuota"."resetsAt" <= CURRENT_TIMESTAMP THEN 1 ELSE LEAST("RequestQuota"."hits" + 1, ${max + 1}) END,
      "resetsAt" = CASE WHEN "RequestQuota"."resetsAt" <= CURRENT_TIMESTAMP THEN EXCLUDED."resetsAt" ELSE "RequestQuota"."resetsAt" END
    RETURNING "hits"
  `;
  return row.hits <= max;
}

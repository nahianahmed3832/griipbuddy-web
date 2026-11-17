import "./load-env.ts";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { checkoutInput } from "../src/lib/commerce/checkout-types.ts";
import { getDb } from "../src/lib/db/client.ts";
import { requireOperatingDatabase } from "../src/lib/db/local.ts";

const legacyUser = z.strictObject({
  legacyCustomerId: z.string().regex(/^[0-9a-f]{24}$/i).transform(id => id.toLowerCase()),
  phoneNumber: z.string().max(48),
  phoneVerified: z.boolean(),
});
const path = process.argv[2];
if (!path || process.argv.length !== 3 || statSync(path).size > 12_000_000) {
  throw new Error("Provide one private legacy customer manifest, up to 12 MB.");
}
requireOperatingDatabase();
const input = z.array(legacyUser).max(50_000).safeParse(JSON.parse(readFileSync(path, "utf8")));
if (!input.success) throw new Error("The manifest must contain legacyCustomerId, phoneNumber and phoneVerified for each customer.");

const normalize = checkoutInput.shape.customer.shape.phone;
const rows = input.data.map(row => ({ ...row, phone: normalize.safeParse(row.phoneNumber).data }));
const byId = new Map<string, number>();
const byPhone = new Map<string, number>();
for (const row of rows) {
  byId.set(row.legacyCustomerId, (byId.get(row.legacyCustomerId) ?? 0) + 1);
  if (row.phone) byPhone.set(row.phone, (byPhone.get(row.phone) ?? 0) + 1);
}
const eligible = [...byPhone.keys()].filter(phone => byPhone.get(phone) === 1);
const db = getDb();
try {
  const owners = new Map<string, string>();
  for (let offset = 0; offset < eligible.length; offset += 500) {
    const matches = await db.shopper.findMany({
      where: { phoneNumber: { in: eligible.slice(offset, offset + 500) }, phoneNumberVerified: true },
      select: { id: true, phoneNumber: true },
    });
    for (const match of matches) if (match.phoneNumber) owners.set(match.phoneNumber, match.id);
  }
  const results = rows.sort((a, b) => a.legacyCustomerId.localeCompare(b.legacyCustomerId)).map(row => {
    const shopperId = row.phone ? owners.get(row.phone) : undefined;
    const status = byId.get(row.legacyCustomerId) !== 1 || row.phone && byPhone.get(row.phone) !== 1 ? "ambiguous"
      : !row.phoneVerified || !row.phone ? "verification-required"
        : shopperId ? "review-match" : "no-verified-shopper";
    return { legacyCustomerId: row.legacyCustomerId, status, ...(status === "review-match" && { shopperId }) };
  });
  process.stdout.write(JSON.stringify({ mode: "read-only", results }, null, 2) + "\n");
} finally {
  await db.$disconnect();
}

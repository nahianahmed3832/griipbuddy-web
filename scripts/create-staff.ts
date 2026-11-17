import "./load-env.ts";
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { isMarketId } from "../src/config/markets.ts";
import { z } from "zod";
import { getDb } from "../src/lib/db/client.ts";
import { requireOperatingDatabase } from "../src/lib/db/local.ts";

requireOperatingDatabase();
const [roleArg, emailArg, ...nameParts] = process.argv.slice(2);
const role = roleArg === "owner" ? "OWNER" : roleArg === "packer" ? "PACKER" : null;
const email = emailArg?.trim().toLowerCase() ?? "";
const name = nameParts.join(" ").trim();
const specified = [...new Set((process.env.STAFF_MARKETS ?? "bd,us").split(",").map(value => value.trim()))];
const marketIds = specified.filter(isMarketId);
if (marketIds.length !== specified.length) throw new Error("STAFF_MARKETS must contain market codes bd or us, separated by commas.");
if (!role || !z.email().max(254).safeParse(email).success || name.length < 2 || name.length > 100) {
  throw new Error('Usage: npm run staff:create -- owner|packer staff@example.com "Staff Name" < password-file');
}
if (process.stdin.isTTY) {
  throw new Error("Supply a unique password through stdin. See the setup instructions for a hidden password prompt.");
}
let password = "";
process.stdin.setEncoding("utf8");
for await (const part of process.stdin) {
  password += part;
  if (password.length > 130) throw new Error("The password must be 14 to 128 characters.");
}
password = password.replace(/\r?\n$/, "");
if (password.length < 14 || password.length > 128 || /[\r\n]/.test(password)) throw new Error("The password must be 14 to 128 characters.");

const hash = await hashPassword(password);
const db = getDb();
try {
  await db.$transaction(async (tx) => {
    if (await tx.user.findUnique({ where: { email }, select: { id: true } })) {
      throw new Error("That staff email already exists.");
    }
    const userId = randomUUID();
    await tx.user.create({
      data: {
        id: userId, name, email, emailVerified: true,
        staff: { create: { role, marketIds } },
        accounts: { create: { id: randomUUID(), providerId: "credential", accountId: userId, password: hash } },
      },
    });
    await tx.auditEvent.create({ data: { action: "STAFF_CREATED", target: userId, changes: { role, marketIds, source: "database operator" } } });
  });
  console.log(`Created ${role.toLowerCase()} account for ${email}.`);
} finally {
  await db.$disconnect();
}

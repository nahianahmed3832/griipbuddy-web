import "./load-env.ts";
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { getDb } from "../src/lib/db/client.ts";
import { requireOperatingDatabase } from "../src/lib/db/local.ts";
import { isMarketSelectable } from "../src/lib/market-config.ts";

requireOperatingDatabase();
const [roleArg, emailArg, ...details] = process.argv.slice(2);
const args = details.at(-1);
const markets = args?.startsWith("--markets=") ? args.slice("--markets=".length).split(",") : [];
const nameParts = markets.length ? details.slice(0, -1) : details;
const role = roleArg === "owner" ? "OWNER" : roleArg === "packer" ? "PACKER" : null;
const email = emailArg?.trim().toLowerCase() ?? "";
const name = nameParts.join(" ").trim();
if (!role || !z.email().max(254).safeParse(email).success || name.length < 2 || name.length > 100) {
  throw new Error('Usage: npm run staff:create -- owner|packer staff@example.com "Staff Name" < password-file');
}
const operationMarkets = [...new Set(markets.filter(isMarketSelectable))];
if (role === "PACKER" ? !operationMarkets.length || operationMarkets.length !== markets.length : markets.length) {
  throw new Error('Choose explicit packing markets with --markets=bd or --markets=bd,us. Owners have central access.');
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
        staff: { create: { role, marketGrants: { create: operationMarkets.map(marketId => ({ marketId, operations: true })) } } },
        accounts: { create: { id: randomUUID(), providerId: "credential", accountId: userId, password: hash } },
      },
    });
      await tx.auditEvent.create({ data: { action: "STAFF_CREATED", target: userId, changes: { role, operationMarkets, source: "database operator" } } });
  });
  console.log(`Created ${role.toLowerCase()} account for ${email}.`);
} finally {
  await db.$disconnect();
}

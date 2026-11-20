import "./load-env.ts";
import { z } from "zod";
import { getDb } from "../src/lib/db/client.ts";
import { requireOperatingDatabase } from "../src/lib/db/local.ts";

requireOperatingDatabase();
const email = z.email().max(254).parse(process.argv[2]?.trim().toLowerCase());
const db = getDb();
try {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(4103, 13)`;
    const staff = await tx.staffAccess.findFirst({ where: { user: { email } } });
    if (!staff) throw new Error("Staff account not found.");
    if (staff.active && staff.role === "OWNER" && await tx.staffAccess.count({ where: { role: "OWNER", active: true } }) < 2) {
      throw new Error("Create another owner before revoking the final active owner.");
    }
    await tx.staffAccess.update({ where: { userId: staff.userId }, data: { active: false } });
    await tx.session.deleteMany({ where: { userId: staff.userId } });
    if (staff.active) {
      await tx.auditEvent.create({ data: { action: "STAFF_REVOKED", target: staff.userId, changes: { source: "database operator" } } });
    }
  });
  console.log("Staff access and active sessions revoked.");
} finally {
  await db.$disconnect();
}

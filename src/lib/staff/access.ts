import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "../db/client";
import { staffAuth } from "./auth";

export const getStaff = cache(async () => {
  const session = await staffAuth().api.getSession({ headers: await headers() });
  if (!session) return null;
  const row = await getDb().staffAccess.findUnique({
    where: { userId: session.user.id },
    include: { user: { select: { name: true } } },
  });
  if (!row?.active) return null;
  return { id: row.userId, name: row.user.name, role: row.role, marketIds: row.marketIds };
});

export async function requireStaff() {
  const staff = await getStaff();
  if (!staff) redirect("/staff/login");
  return staff;
}

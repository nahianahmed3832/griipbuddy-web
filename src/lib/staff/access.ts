import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "../db/client";
import { staffAuth } from "./auth";

export async function getStaffFromHeaders(incoming: Headers) {
  const session = await staffAuth().api.getSession({ headers: incoming });
  if (!session) return null;
  const row = await getDb().staffAccess.findUnique({
    where: { userId: session.user.id },
    include: { user: { select: { name: true } } },
  });
  if (!row?.active) return null;
  return { id: row.userId, name: row.user.name, role: row.role };
}

export const getStaff = cache(async () => getStaffFromHeaders(await headers()));

export async function requireStaff() {
  const staff = await getStaff();
  if (!staff) redirect("/staff/login");
  return staff;
}

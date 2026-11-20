type Principal<Kind extends string> = { kind: Kind; id: string };

export type StaffActor =
  | (Principal<"core-admin"> & { role: "OWNER" })
  | (Principal<"market-staff"> & { role: "PACKER" });

export type ShopperActor = Principal<"customer">;
export type SellerActor = Principal<"seller-owner"> & { shopId: string };
export type GuestActor = Principal<"guest">;
export type StaffBridgeActor = Principal<"internal-service"> & {
  service: "editable-admin";
  operator: StaffActor;
  legacyId: string;
};

export function activeStaffActor(row: { userId: string; role: string; active: boolean } | null): StaffActor | null {
  if (!row?.active) return null;
  if (row.role === "OWNER") return { kind: "core-admin", id: row.userId, role: row.role };
  if (row.role === "PACKER") return { kind: "market-staff", id: row.userId, role: row.role };
  return null;
}

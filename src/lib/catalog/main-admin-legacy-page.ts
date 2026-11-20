import { notFound } from "next/navigation";
import { requireStaff } from "../staff/access";
import { staffMarketIds } from "../staff/market-access";
import { mainAdminCatalogRequested } from "./main-admin-config";
import { scopedCatalogPilotReady } from "./scoped-pilot";

export async function requireLegacyCatalogPage(workspace?: "merchandising") {
  const staff = await requireStaff();
  const transferred = mainAdminCatalogRequested();
  const canMerchandise = transferred && workspace === "merchandising" && staff.role !== "OWNER" &&
    (await staffMarketIds(staff.id, "merchandising")).length > 0;
  const pilotReady = transferred && (staff.role === "OWNER" || canMerchandise) && await scopedCatalogPilotReady();
  if (transferred && !pilotReady) notFound();
  return { ...staff, scopedLegacyPilot: pilotReady && staff.role === "OWNER", scopedMerchandising: pilotReady && canMerchandise };
}

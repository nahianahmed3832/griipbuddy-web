import { developmentAcceptanceDatabase, localDatabase } from "../db/local.ts";
import { OperationError } from "../staff/operation-error.ts";

export const legacyStaffIdPattern = /^[a-f0-9]{24}$/;
const nativeStaffIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
export function mainAdminHomepageRequested() {
  return process.env.GRIIP_MAIN_ADMIN_HOMEPAGE_ENABLED === "1" && Boolean(localDatabase() || developmentAcceptanceDatabase());
}

export function mainAdminCatalogConfig(homepage = false) {
  const local = localDatabase();
  if (!local && !developmentAcceptanceDatabase()) return null;
  if (homepage && !mainAdminHomepageRequested()) return null;
  const secret = homepage ? process.env.GRIIP_MAIN_ADMIN_HOMEPAGE_SECRET : process.env.GRIIP_MAIN_ADMIN_CATALOG_SECRET;
  const origin = homepage ? process.env.GRIIP_MAIN_ADMIN_HOMEPAGE_ORIGIN : process.env.GRIIP_MAIN_ADMIN_CATALOG_ORIGIN;
  const directory = homepage ? process.env.GRIIP_MAIN_ADMIN_HOMEPAGE_ACTORS : process.env.GRIIP_MAIN_ADMIN_CATALOG_ACTORS;
  if (!secret || Buffer.byteLength(secret) < 32 || !origin || !directory) return null;
  try {
    const url = new URL(origin);
    if (url.origin !== origin) return null;
    if (local ? url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      : origin !== "https://devadmin.griipbuddy.com") return null;
    const entries: unknown = JSON.parse(directory);
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return null;
    const actors = new Map<string, string>();
    const nativeIds = new Set<string>();
    for (const [legacyId, nativeId] of Object.entries(entries)) {
      if (!legacyStaffIdPattern.test(legacyId) || typeof nativeId !== "string" ||
          !nativeStaffIdPattern.test(nativeId) || nativeIds.has(nativeId)) return null;
      actors.set(legacyId, nativeId);
      nativeIds.add(nativeId);
    }
    return actors.size ? { origin, secret, actors } : null;
  } catch {
    return null;
  }
}

export function requireLegacyCatalogBrowser() {
  if (mainAdminCatalogConfig()) {
    throw new OperationError("Open the main GriipBuddy admin to manage the catalog.");
  }
}

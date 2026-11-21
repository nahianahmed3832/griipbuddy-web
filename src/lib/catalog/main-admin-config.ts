import { developmentAcceptanceDatabase, localDatabase } from "../db/local.ts";
import { OperationError } from "../staff/operation-error.ts";

export const legacyStaffIdPattern = /^[a-f0-9]{24}$/;
const nativeStaffIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const canonicalDevelopmentAdminOrigin = "https://admindev.griipbuddy.com";
const legacyDevelopmentHomepageOrigin = "https://devadmin.griipbuddy.com";
const channelSecretSettings = {
  catalog: "GRIIP_MAIN_ADMIN_CATALOG_SECRET",
  homepage: "GRIIP_MAIN_ADMIN_HOMEPAGE_SECRET",
  marketplace: "GRIIP_MAIN_ADMIN_MARKETPLACE_SECRET",
} as const;
const bridgeSettings = [channelSecretSettings.catalog, "GRIIP_MAIN_ADMIN_CATALOG_ORIGIN", "GRIIP_MAIN_ADMIN_CATALOG_ACTORS"] as const;

function channelSecret(channel: keyof typeof channelSecretSettings) {
  const setting = channelSecretSettings[channel];
  const secret = process.env[setting];
  if (!secret || Buffer.byteLength(secret) < 32) return null;
  return Object.values(channelSecretSettings).some(other => other !== setting && process.env[other] === secret) ? null : secret;
}

export function scopedCatalogPilotRequested() {
  const flag = process.env.GRIIP_MAIN_ADMIN_CATALOG_SCOPED_PILOT;
  return Boolean(localDatabase() || developmentAcceptanceDatabase()) &&
    (Boolean(flag && flag !== "0") || Boolean(process.env.GRIIP_MAIN_ADMIN_CATALOG_REVIEW_DIGEST));
}

export function mainAdminCatalogDormant() {
  return process.env.GRIIP_MAIN_ADMIN_CATALOG_DORMANT === "1" && developmentAcceptanceDatabase() &&
    !scopedCatalogPilotRequested() && !bridgeSettings.some(key => Boolean(process.env[key]));
}

export function mainAdminCatalogRequested() {
  if (developmentAcceptanceDatabase()) return !mainAdminCatalogDormant();
  return scopedCatalogPilotRequested() ||
    Boolean(localDatabase() && bridgeSettings.some(key => Boolean(process.env[key])));
}

export function scopedCatalogPilotDigest() {
  const digest = process.env.GRIIP_MAIN_ADMIN_CATALOG_REVIEW_DIGEST;
  return process.env.GRIIP_MAIN_ADMIN_CATALOG_SCOPED_PILOT === "1" &&
    digest && /^[0-9a-f]{64}$/.test(digest) && mainAdminCatalogConfig() ? digest : null;
}

export function mainAdminHomepageRequested() {
  return process.env.GRIIP_MAIN_ADMIN_HOMEPAGE_ENABLED === "1" && Boolean(localDatabase() || developmentAcceptanceDatabase());
}

export function mainAdminCatalogConfig(homepage = false) {
  const local = localDatabase();
  if (!local && !developmentAcceptanceDatabase()) return null;
  if (homepage && !mainAdminHomepageRequested()) return null;
  const secret = channelSecret(homepage ? "homepage" : "catalog");
  const origin = homepage ? process.env.GRIIP_MAIN_ADMIN_HOMEPAGE_ORIGIN : process.env.GRIIP_MAIN_ADMIN_CATALOG_ORIGIN;
  const directory = homepage ? process.env.GRIIP_MAIN_ADMIN_HOMEPAGE_ACTORS : process.env.GRIIP_MAIN_ADMIN_CATALOG_ACTORS;
  if (!secret || !origin || !directory) return null;
  try {
    const url = new URL(origin);
    if (url.origin !== origin) return null;
    // The existing Homepage profile supplies the Marketplace channel's identity too.
    if (local ? url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      : origin !== canonicalDevelopmentAdminOrigin && !(homepage && origin === legacyDevelopmentHomepageOrigin)) return null;
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

export function mainAdminMarketplaceConfig() {
  if (process.env.GRIIP_MAIN_ADMIN_MARKETPLACE_ENABLED !== "1") return null;
  const secret = channelSecret("marketplace");
  const identity = mainAdminCatalogConfig(true);
  if (!identity || !secret) return null;
  return { ...identity, secret };
}

export function requireLegacyCatalogBrowser() {
  if (mainAdminCatalogRequested()) {
    throw new OperationError("Open the main GriipBuddy admin to manage the catalog.");
  }
}

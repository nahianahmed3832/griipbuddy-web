import { hybridDemoMode, marketplaceMode, productionMode, productionOrigin } from "../release-config.ts";

type LocalDatabase = "griipbuddy_dev" | "griipbuddy_test";

export function localDatabase(): LocalDatabase | null {
  if (process.env.COMMERCE_MODE !== "local" || !process.env.DATABASE_URL) return null;
  try {
    const url = new URL(process.env.DATABASE_URL);
    if (!["postgresql:", "postgres:"].includes(url.protocol)) return null;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.search) return null;
    const name = url.pathname.slice(1);
    return name === "griipbuddy_dev" || name === "griipbuddy_test" ? name : null;
  } catch {
    return null;
  }
}

export function requireLocalDatabase(expected?: LocalDatabase) {
  const name = localDatabase();
  if (!name || (expected && name !== expected)) {
    throw new Error("This command requires COMMERCE_MODE=local and a dedicated loopback GriipBuddy database.");
  }
  return name;
}

export function stagingDatabase(): boolean {
  if (process.env.COMMERCE_MODE !== "staging" || !process.env.DATABASE_URL) return false;
  if (hybridDemoMode()) return true;
  try {
    const url = new URL(process.env.DATABASE_URL);
    const pilot = process.env.GRIIP_HOSTINGER_PILOT === "1";
    if (marketplaceMode()) {
      return !pilot && ["postgresql:", "postgres:"].includes(url.protocol) && url.hostname === "db" &&
        url.pathname === "/griipbuddy_marketplace_dev" && url.username === "griipbuddy_marketplace" && Boolean(url.password) &&
        (url.port === "" || url.port === "5432") && !url.search && !url.hash;
    }
    return ["postgresql:", "postgres:"].includes(url.protocol) && url.hostname === "db" &&
      url.pathname === (pilot ? "/griipbuddy_pilot_stage" : "/griipbuddy_staging") && !url.search &&
      (!pilot || (url.username === "griipbuddy_pilot" && Boolean(url.password) && !url.hash &&
        (url.port === "5432" || url.port === "")));
  } catch {
    return false;
  }
}

export function isOperatingDatabase(): boolean {
  return hybridDemoMode() || localDatabase() !== null || stagingDatabase() || productionDatabase();
}

export function requireOperatingDatabase() {
  if (!isOperatingDatabase()) throw new Error("Use a dedicated GriipBuddy database with the correct deployment profile.");
}
export function productionDatabase(): boolean {
  if (!productionMode() || process.env.BETTER_AUTH_URL !== productionOrigin || !process.env.DATABASE_URL) return false;
  try {
    const url = new URL(process.env.DATABASE_URL);
    return ["postgresql:", "postgres:"].includes(url.protocol) &&
      url.hostname === "db" && (url.port === "5432" || url.port === "") &&
      url.pathname === "/griipbuddy_production" && !url.search && !url.hash &&
      ["griipbuddy_prod_app", "griipbuddy_prod_operator"].includes(url.username) && Boolean(url.password);
  } catch {
    return false;
  }
}

import { readFileSync } from "node:fs";
import { z } from "zod";
import { storefrontBasePath, storefrontPath } from "../config/storefront-path.ts";

export const productionOrigin = "https://frontend.griipbuddy.com";

const paragraphs = z.array(z.string().trim().min(1).max(2500)).min(1).max(12);
const approvedContent = z.object({
  delivery: paragraphs, returns: paragraphs, privacy: paragraphs, terms: paragraphs,
}).strict();
export type PolicyTopic = keyof z.infer<typeof approvedContent>;

export function productionMode() {
  return process.env.COMMERCE_MODE === "production";
}

export function marketplaceMode() {
  return process.env.GRIIP_MARKETPLACE_PREVIEW === "1" &&
    (process.env.COMMERCE_MODE === "local" || process.env.COMMERCE_MODE === "staging");
}

export function hybridDemoMode() {
  if (!marketplaceMode() || process.env.GRIIP_HYBRID_STOREFRONT !== "1") return false;
  try {
    const database = new URL(process.env.DATABASE_URL ?? "");
    if (!["postgres:", "postgresql:"].includes(database.protocol) || database.search || database.hash) return false;
    if (process.env.COMMERCE_MODE === "local") {
      return ["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) && database.pathname === "/griipbuddy_hybrid_test";
    }
    return database.hostname === "db" && database.pathname === "/griipbuddy_hybrid_demo" &&
      database.username === "griipbuddy_demo" && Boolean(database.password) &&
      (!database.port || database.port === "5432") && process.env.BETTER_AUTH_URL === "https://dev.griipbuddy.com";
  } catch {
    return false;
  }
}

export function hybridStoreMode() {
  return marketplaceMode() && process.env.GRIIP_HYBRID_STOREFRONT === "1";
}

export function firstPartyStoreMode() {
  return marketplaceMode() && !hybridStoreMode() && process.env.GRIIP_FIRST_PARTY_STOREFRONT === "1";
}

let loaded: { path: string; content: z.infer<typeof approvedContent> | null } | undefined;

export function productionContent() {
  const path = process.env.STOREFRONT_POLICY_FILE;
  if (!productionMode() || !path) return null;
  if (loaded?.path !== path) {
    try {
      const result = approvedContent.safeParse(JSON.parse(readFileSync(path, "utf8")));
      loaded = { path, content: result.success ? result.data : null };
    } catch {
      loaded = { path, content: null };
    }
  }
  return loaded.content;
}

export function storefrontIndexingEnabled() {
  return productionContent() !== null;
}

export function orderIntakeOpen() {
  if (marketplaceMode() && process.env.COMMERCE_MODE === "staging") return process.env.MARKETPLACE_TEST_INTAKE_OPEN === "1";
  return !productionMode() || (process.env.ORDER_INTAKE_OPEN === "1" && productionContent() !== null);
}

export function canonicalUrl(path: string) {
  if (!productionMode()) return undefined;
  return new URL(path === "/" && storefrontBasePath ? storefrontBasePath : storefrontPath(path), productionOrigin).href;
}

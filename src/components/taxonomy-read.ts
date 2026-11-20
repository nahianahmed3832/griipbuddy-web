import { storefrontPath } from "../config/storefront-path";

export async function readTaxonomyData<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(storefrontPath(`/api/staff/catalog/${path}`), { cache: "no-store", ...init });
  const result = await response.json().catch(() => null);
  if (!response.ok || result === null) {
    throw new Error(result?.error?.message ?? "The catalog could not be loaded. Try again.");
  }
  return result as T;
}

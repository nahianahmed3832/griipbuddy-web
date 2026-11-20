import { createHash } from "node:crypto";
import { z } from "zod";

export const migrationVersion = "catalog-stage5-v1";
export const nativeSourceSystem = "native-postgres";

export const migrationIssueInput = z.strictObject({
  code: z.string().min(1).max(100), reference: z.string().min(1).max(500), message: z.string().min(1).max(1000),
});
export type MigrationIssue = z.infer<typeof migrationIssueInput>;
export type MigrationMapping = { sourceSystem: string; entity: string; sourceId: string; targetId: string };

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "bigint") return value.toString();
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]));
  }
  return value;
}

export function migrationDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function mappingTargetId(...parts: string[]) {
  return JSON.stringify(parts);
}

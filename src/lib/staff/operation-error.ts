import type { z } from "zod";
import { validationMessage } from "./catalog-input.ts";

export class OperationError extends Error {}

const catalogStatuses = { invalid_input: 400, forbidden: 403, not_found: 404, conflict: 409, market_mismatch: 409, rate_limited: 429 } as const;

export class CatalogWriteError extends OperationError {
  readonly status: (typeof catalogStatuses)[keyof typeof catalogStatuses];

  constructor(readonly code: keyof typeof catalogStatuses, message: string,
    readonly fields?: { path: string; message: string }[]) {
    super(message);
    this.status = catalogStatuses[code];
  }
}

export function catalogWriteInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new CatalogWriteError("invalid_input", validationMessage(parsed.error), parsed.error.issues.slice(0, 8).map(issue => ({
    path: issue.path.map(String).join("."), message: issue.message,
  })));
}

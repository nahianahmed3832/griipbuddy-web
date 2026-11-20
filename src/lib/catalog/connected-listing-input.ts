import { createHash } from "node:crypto";
import { z } from "zod";
import { CatalogApiError, type CatalogReadContext } from "./connected-public.ts";
import { deviceLookupKey } from "./device-fitment.ts";
import { sortOptions } from "./listing.ts";

const text = z.string().trim().min(1).max(120).regex(/^[^\p{Cc}]+$/u);
const facet = z.array(text).max(12);
const key = z.string().trim().min(1).max(80).regex(/^[^:\p{Cc}]+$/u);
const minorUnits = z.string().regex(/^\d{1,10}$/).transform(Number).pipe(z.number().int().max(2_147_483_647));
const availability = z.enum(["available", "out_of_stock", "delivery_unavailable", "browse_only"]);
const boolean = z.enum(["true", "false"]).transform(value => value === "true");
const typedValue = z.union([text, z.number().finite(), z.boolean()]);

function keyValue<T extends z.ZodType>(value: T, parse: (text: string) => unknown) {
  return z.string().max(320).transform((raw, ctx) => {
    const separator = raw.indexOf(":");
    const parsedKey = key.safeParse(raw.slice(0, separator));
    let input: unknown;
    try {
      input = parse(raw.slice(separator + 1));
    } catch { /* Invalid values fail the schema below. */ }
    const parsedValue = value.safeParse(input);
    if (separator === -1 || !parsedKey.success || !parsedValue.success) {
      ctx.addIssue({ code: "custom", message: "Use a name and supported value separated by a colon." });
      return z.NEVER;
    }
    return { key: parsedKey.data, value: parsedValue.data };
  });
}

const digestInput = z.string().regex(/^[0-9a-f]{64}$/);
const cursorPayload = z.strictObject({ scope: digestInput, sequence: digestInput, id: z.string().min(1).max(160) });
type ListingCursor = z.infer<typeof cursorPayload>;

const singletonFields = {
  category: text.optional(), collection: text.optional(), q: text.optional(),
  minMinor: minorUnits.optional(), maxMinor: minorUnits.optional(),
  sale: boolean.optional(),
  sort: z.enum(sortOptions.map(([name]) => name)).default("recommended"),
  limit: z.string().regex(/^\d{1,2}$/).transform(Number).pipe(z.number().int().min(1).max(48)).default(24),
  cursor: z.string().regex(/^[a-zA-Z0-9_-]{1,520}$/).optional(),
};
const multiFields = {
  brand: facet, model: facet, design: facet, color: facet, availability: z.array(availability).max(4),
  option: z.array(keyValue(text, value => value).transform(({ key, value }) => ({ key: deviceLookupKey(key), value }))
    .refine(({ key }) => key.length > 0)).max(24),
  attribute: z.array(keyValue(typedValue, value => JSON.parse(value) as unknown)).max(24),
};
const listingInput = z.strictObject({ ...singletonFields, ...multiFields }).refine(
  ({ minMinor, maxMinor }) => minMinor === undefined || maxMinor === undefined || minMinor <= maxMinor,
);

export type CatalogListingInput = z.infer<typeof listingInput>;

export function parseCatalogListing(params: URLSearchParams) {
  const data = Object.create(null) as Record<string, string | string[]>;
  for (const name of new Set(params.keys())) {
    const values = params.getAll(name);
    if (Object.hasOwn(multiFields, name)) data[name] = values;
    else if (Object.hasOwn(singletonFields, name) && values.length === 1) data[name] = values[0];
    else throw new CatalogApiError(400, "invalid_filters", "Use supported catalog filters and one value for each single-value field.");
  }
  for (const name of Object.keys(multiFields)) data[name] ??= [];
  const parsed = listingInput.safeParse(data);
  if (!parsed.success) throw new CatalogApiError(400, "invalid_filters", "The catalog filters, sort, or page limit are invalid.");
  return parsed.data;
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function listingScope(input: CatalogListingInput, context: CatalogReadContext) {
  const ordered = Object.entries(input).filter(([key]) => key !== "cursor").map(([key, value]) => [key, Array.isArray(value) ? [...value].sort(
    (left: unknown, right: unknown) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"),
  ) : value]);
  return digest([context.marketId, context.locale, context.delivery, ordered]);
}

export function listingPage<T extends { id: string }>(items: T[], input: CatalogListingInput, scope: string) {
  const sequence = digest(items.map(({ id }) => id));
  let start = 0;
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor);
    if (!cursor || cursor.scope !== scope) throw new CatalogApiError(400, "invalid_cursor", "The cursor does not match this catalog request.");
    if (cursor.sequence !== sequence) throw new CatalogApiError(409, "catalog_changed", "The catalog results changed. Restart at the first page.");
    const offset = items.findIndex(({ id }) => id === cursor.id);
    if (offset < 0) throw new CatalogApiError(400, "invalid_cursor", "The cursor does not match this catalog request.");
    start = offset + 1;
  }
  const page = items.slice(start, start + input.limit);
  const last = page.at(-1);
  const nextCursor = last && start + input.limit < items.length
    ? Buffer.from(JSON.stringify({ scope, sequence, id: last.id } satisfies ListingCursor)).toString("base64url")
    : null;
  return { items: page, nextCursor };
}

function decodeCursor(cursor: string): ListingCursor | null {
  try {
    const result = cursorPayload.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

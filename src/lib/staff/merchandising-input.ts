import { createHash } from "node:crypto";
import { z } from "zod";
import { markets, type MarketId } from "../../config/markets.ts";
import { catalogImage, productIdField, productInput, textField, type ProductInput } from "./catalog-input.ts";

export function digest(value: unknown) {
  const serialized = JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
  return createHash("sha256").update(serialized).digest("hex");
}
export const candidateId = z.string().regex(/^[a-f0-9]{64}$/);
export const marketId = z.enum(["bd", "us"]);
const reference = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 ._:/-]{0,119}$/);
const plain = (minimum: number, maximum: number) => textField(minimum, maximum).refine(
  (value) => !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value),
  "Use plain text without markup or control characters.",
);
const url = z.url({ protocol: /^https$/ }).max(400).refine((value) => {
  const parsed = new URL(value);
  return !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
}, "Use a source URL without credentials, query strings, or fragments.");
const currency = z.enum(["BDT", "USD"]);
const amount = z.number().int().min(0).max(15_000_000);
const quantity = z.number().int().min(1).max(1000);
export const costs = ["shipping", "packaging", "transaction", "tax", "other"] as const;
const costValue = z.object({ minor: amount, evidence: reference }).strict();
const exchange = z.object({
  from: currency, to: currency, rate: z.string().regex(/^\d{1,5}(?:\.\d{1,8})?$/).refine((value) => Number(value) > 0),
  evidence: reference, observedOn: z.iso.date(),
}).strict();
const scenario = z.object({
  market: marketId, sku: textField(1, 60), quantity,
  productCost: costValue.extend({ currency }).optional(),
  direct: z.partialRecord(z.enum(costs), costValue).default({}),
  exchange: exchange.optional(),
}).strict();
const imageApproval = catalogImage.pick({ src: true }).extend({ evidence: reference, usage: plain(4, 180) }).strict();
const confirmation = z.object({ field: plain(1, 90), value: plain(1, 240), evidence: reference, status: z.enum(["supplier", "verified"]) }).strict();
const marketReview = z.object({ market: marketId, delivery: reference.optional(), content: reference.optional(), decision: reference.optional() }).strict();
export const evidenceInput = z.object({
  sourceProductId: reference.optional(),
  sourceUrl: url.optional(),
  sourceRecord: reference.optional(),
  supplierSkus: z.record(textField(1, 60), reference).default({}).refine((value) => Object.keys(value).length <= 40),
  images: z.array(imageApproval).max(96).default([]),
  confirmations: z.array(confirmation).max(60).default([]),
  markets: z.array(marketReview).max(2).default([]),
  scenarios: z.array(scenario).max(12).default([]),
  supplierAvailability: plain(1, 160).optional(),
}).strict().superRefine((value, ctx) => {
  for (const [field, keys] of [
    ["images", value.images.map((image) => image.src)],
    ["confirmations", value.confirmations.map((item) => item.field.toLowerCase())],
    ["markets", value.markets.map((item) => item.market)],
    ["scenarios", value.scenarios.map((item) => item.market + "/" + item.sku.toUpperCase())],
  ] as const) {
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "Keep one record per reference.", path: [field] });
  }
});
export const evidenceManifest = z.record(productIdField, evidenceInput).refine((value) => Object.keys(value).length <= 150);
export const supplierRef = reference;
export type EvidenceInput = z.infer<typeof evidenceInput>;
export type CostScenario = z.infer<typeof scenario>;

export function safeProductText(product: ProductInput) {
  const values = [
    product.name, product.shortDescription ?? "", product.description, ...product.keywords,
    ...product.specifications.flatMap(({ label, value }) => [label, value]),
    ...product.images.map(({ alt }) => alt),
    ...product.variants.flatMap((item) => [...Object.entries(item.options).flat(), item.image?.alt ?? ""]),
  ];
  return values.every((value) => plain(0, 4000).safeParse(value).success);
}

export const draftInput = productInput.refine((product) => product.publication === "DRAFT", {
  path: ["publication"],
  message: "Keep the proposed catalog listing as a draft.",
});

export function listingText(name: string, features: readonly { label: string; value: string }[], focus: readonly number[]) {
  const facts = focus.map((index) => features[index]).filter(Boolean);
  return {
    shortDescription: facts.length ? `${name} · ${facts[0].label}: ${facts[0].value}`.slice(0, 240) : name,
    description: [name, ...facts.map(({ label, value }) => `${label}: ${value}`)].join("\n"),
  };
}

export function launchText(product: ProductInput, market: MarketId, focus: readonly number[], angle: "details" | "options", destination?: string) {
  const productName = product.name;
  const highlights = focus.map((index) => product.specifications[index]).filter(Boolean)
    .map(({ label, value }) => `${label}: ${value}`);
  const optionNames = [...new Set(product.variants.filter(({ active }) => active).flatMap(({ options }) => Object.keys(options)))];
  const headline = angle === "options" && optionNames.length ? `Explore the options for ${productName}` : `Get to know ${productName}`;
  const images = [...new Set([...product.images.map(({ src }) => src),
    ...product.variants.flatMap(({ image }) => image ? [image.src] : [])])].slice(0, 3);
  const summary = highlights.length ? highlights.join(" · ") : "Show the product and its listed options.";
  return {
    brief: `Introduce ${productName} for ${markets[market].name}. ${summary}`,
    headlines: [headline, `${productName} up close`],
    captions: [`Introducing ${productName}.${highlights.length ? ` ${highlights[0]}.` : ""}`,
      `A closer look at ${productName}.${optionNames.length ? ` See the listed ${optionNames.join(" and ").toLowerCase()} options.` : ""}`],
    script: [`0–3s: Show the approved hero image with “${productName}” on screen.`,
      `3–9s: Show an approved detail image.${highlights.length ? ` Add “${highlights[0]}” as an on-screen label.` : ""}`,
      `9–15s: End on the product name${destination ? " and the product-page link" : ""}.`],
    images, cta: destination ? "View product" : "View product once the listing is available", destination,
  };
}

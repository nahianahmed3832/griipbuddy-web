import { z } from "zod";
import { storefrontPath } from "../../config/storefront-path.ts";
import type { CheckoutQuote } from "./checkout-types.ts";
import { prepaidConfig } from "./prepaid-config.ts";

const sandboxHost = "https://sandbox.sslcommerz.com";
const reference = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/);
const requiredConfig = () => {
  const config = prepaidConfig();
  if (!config) throw new Error("SSLCOMMERZ sandbox is unconfigured.");
  return config;
};

async function providerJson(url: URL | string, options: RequestInit = {}): Promise<unknown> {
  try {
    const response = await fetch(url, { ...options, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8_000) });
    if (response.ok) return await response.json();
  } catch {
    // A fetch error may include the validation URL and its merchant password.
  }
  throw new Error("SSLCOMMERZ sandbox is temporarily unavailable.");
}

export async function openPrepaidSession(providerId: string, quote: CheckoutQuote) {
  const config = requiredConfig();
  const callback = new URL(storefrontPath("/api/checkout/prepaid/callback"), config.origin);
  const notify = new URL(callback);
  notify.searchParams.set("flow", "notify");
  // The public demo credentials share a sandbox with other developers. Use
  // synthetic billing/shipping data there while retaining the address on our order.
  const sample = { name: "GriipBuddy Test Customer", address: "Sample test address", city: "Dhaka", postalCode: "1200" };
  const body = new URLSearchParams({
    store_id: config.storeId, store_passwd: config.password, tran_id: providerId,
    total_amount: (quote.totalMinor / 100).toFixed(2), currency: "BDT",
    success_url: callback.href, fail_url: callback.href, cancel_url: callback.href, ipn_url: notify.href,
    shipping_method: "Courier", num_of_item: String(quote.lines.reduce((count, line) => count + line.quantity, 0)),
    product_name: "GriipBuddy sandbox order", product_category: "General merchandise", product_profile: "physical-goods",
    cus_name: sample.name, cus_add1: sample.address, cus_city: sample.city, cus_postcode: sample.postalCode,
    cus_country: "Bangladesh", cus_phone: "01700000000", cus_email: "gateway-test@example.test",
    ship_name: sample.name, ship_add1: sample.address, ship_city: sample.city, ship_postcode: sample.postalCode, ship_country: "Bangladesh",
  });
  const result = z.object({ status: z.literal("SUCCESS"), GatewayPageURL: z.url() }).safeParse(
    await providerJson(`${sandboxHost}/gwprocess/v4/api.php`, { method: "POST", body }),
  );
  if (!result.success) return null;
  const approval = new URL(result.data.GatewayPageURL);
  return approval.origin === sandboxHost && !approval.username && !approval.password ? approval.href : null;
}

const providerRecord = z.object({
  status: z.string(),
  tran_id: z.string(),
  val_id: reference.optional(),
  amount: z.union([z.string(), z.number()]).optional(),
  currency: z.string().optional(),
  currency_type: z.string().optional(),
  risk_level: z.union([z.string(), z.number()]).optional(),
  bank_tran_id: reference.optional(),
});

const paid = (status: string) => status === "VALID" || status === "VALIDATED";

function providerUrl(path: string, lookup: Record<string, string>) {
  const { storeId, password } = requiredConfig();
  const url = new URL(path, sandboxHost);
  url.search = new URLSearchParams({ ...lookup, store_id: storeId, store_passwd: password, format: "json", v: "1" }).toString();
  return url;
}

function matchesAmount(value: string | number | undefined, expectedMinor: number) {
  if (value === undefined) return false;
  const amount = String(value);
  const parts = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(amount);
  return Boolean(parts && Number(parts[1]) * 100 + Number((parts[2] ?? "").padEnd(2, "0")) === expectedMinor);
}

export type PrepaidProviderStatus = { kind: "paid"; bankTransactionId: string } | { kind: "pending" | "closed" | "review" };

export async function lookupPrepaidStatus(providerId: string, totalMinor: number, validationHint?: string): Promise<PrepaidProviderStatus> {
  let validationId = reference.safeParse(validationHint).data;
  if (!validationId) {
    const lookup = z.object({
      APIConnect: z.literal("DONE"),
      element: z.array(z.unknown()).nullish(),
    }).safeParse(await providerJson(providerUrl("/validator/api/merchantTransIDvalidationAPI.php", { tran_id: providerId })));
    if (!lookup.success) throw new Error("SSLCOMMERZ lookup could not be confirmed.");
    const txns = (lookup.data.element ?? []).flatMap(raw => {
      const parsed = providerRecord.safeParse(raw);
      return parsed.success && parsed.data.tran_id === providerId ? [parsed.data] : [];
    });
    const confirmed = txns.filter(row => paid(row.status));
    if (confirmed.length > 1) return { kind: "review" };
    validationId = confirmed[0]?.val_id;
    if (!validationId) {
      const terminal = new Set(["CANCELLED", "EXPIRED"]);
      const noActiveTransaction = txns.length && txns.every(row => terminal.has(row.status) || row.status === "FAILED");
      return { kind: noActiveTransaction && txns.some(row => terminal.has(row.status)) ? "closed" : "pending" };
    }
  }

  const validation = providerRecord.safeParse(await providerJson(
    providerUrl("/validator/api/validationserverAPI.php", { val_id: validationId }),
  ));
  if (!validation.success || validation.data.tran_id !== providerId || !paid(validation.data.status)) return { kind: "pending" };
  const value = validation.data;
  if (value.currency !== "BDT" || (value.currency_type && value.currency_type !== "BDT") ||
      !matchesAmount(value.amount, totalMinor) || String(value.risk_level) !== "0" || !value.bank_tran_id) {
    return { kind: "review" };
  }
  return { kind: "paid", bankTransactionId: value.bank_tran_id };
}

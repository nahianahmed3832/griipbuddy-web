import { createHash } from "node:crypto";
import { z } from "zod";
import { storefrontPath } from "../../config/storefront-path.ts";
import { paypalSandboxConfig } from "./paypal-config.ts";

const sandboxApi = "https://api-m.sandbox.paypal.com";
const providerId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const amount = z.object({ currency_code: z.string(), value: z.string() });
const shipping = z.object({
  address_line_1: z.string(),
  address_line_2: z.string().optional(),
  admin_area_2: z.string(),
  admin_area_1: z.string(),
  postal_code: z.string(),
  country_code: z.string(),
});
export type PayPalAddress = z.infer<typeof shipping>;
const providerCapture = z.object({ id: providerId, status: z.string(), amount });
const providerUnit = z.object({
  reference_id: z.string(),
  payee: z.object({ merchant_id: providerId }).optional(),
  amount: amount.optional(),
  shipping: z.object({ address: shipping }).optional(),
  payments: z.object({ captures: z.array(providerCapture).optional() }).optional(),
});
const providerOrder = z.object({
  id: providerId,
  status: z.string(),
  links: z.array(z.object({ href: z.string(), rel: z.string() })).optional(),
  purchase_units: z.array(providerUnit).optional(),
});
const providerRefund = z.object({
  id: providerId, status: z.string(), amount, custom_id: z.string().optional(),
  links: z.array(z.object({ href: z.string(), rel: z.string() })).optional(),
});
export type PayPalOrder = z.infer<typeof providerOrder>;

export class PayPalProviderError extends Error {
  constructor(readonly status: number, readonly issue?: string) {
    super("PayPal sandbox request could not be confirmed.");
  }
}

async function jsonRequest(url: string, init: RequestInit) {
  const response = await fetch(sandboxApi + url, {
    ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(12_000),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = z.object({ details: z.array(z.object({ issue: z.string() })).optional() }).safeParse(data);
    throw new PayPalProviderError(response.status, detail.success ? detail.data.details?.[0]?.issue : undefined);
  }
  return data;
}

let access: { key: string; token: string; validUntil: number } | undefined;
async function accessToken() {
  const config = paypalSandboxConfig();
  if (!config?.clientId || !config.clientSecret) throw new Error("PayPal sandbox credentials are missing.");
  const key = `${config.marketId}:${config.clientId}`;
  if (access?.key === key && access.validUntil > Date.now()) return access.token;
  const data = await jsonRequest("/v1/oauth2/token", {
    method: "POST", body: "grant_type=client_credentials", headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  const token = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() }).parse(data);
  access = { key, token: token.access_token, validUntil: Date.now() + Math.max(0, token.expires_in - 60) * 1000 };
  return access.token;
}

async function paypalRequest(path: string, body?: object, requestId?: string) {
  const token = await accessToken();
  try {
    return await jsonRequest(path, {
      method: body ? "POST" : "GET",
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation",
        ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
      },
    });
  } catch (error) {
    if (error instanceof PayPalProviderError && error.status === 401 && access?.token === token) access = undefined;
    throw error;
  }
}

export function paypalUsd(minor: number) {
  return { currency_code: "USD", value: (minor / 100).toFixed(2) };
}

export function samePayPalAmount(actual: z.infer<typeof amount> | undefined, minor: number) {
  return actual?.currency_code === "USD" && /^\d{1,9}(?:\.\d{1,2})?$/.test(actual.value) &&
    Math.round(Number(actual.value) * 100) === minor;
}

export async function createSandboxOrder(input: {
  attemptId: string; shippingAddress: PayPalAddress; name: string; totalMinor: number; merchandiseMinor: number; shippingMinor: number;
  taxMinor: number;
  lines: { productName: string; quantity: number; unitPriceMinor: number; unitDiscountMinor: number }[];
}) {
  const config = paypalSandboxConfig();
  if (!config?.merchantId) throw new Error("PayPal sandbox merchant is unconfigured.");
  const returnTo = (result: "return" | "cancel") => {
    const url = new URL(storefrontPath("/checkout"), config.origin);
    url.search = new URLSearchParams({ destination: config.marketId, paypal: result, attempt: input.attemptId }).toString();
    return url.href;
  };
  const data = providerOrder.parse(await paypalRequest("/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{
      reference_id: input.attemptId, payee: { merchant_id: config.merchantId },
      amount: {
        ...paypalUsd(input.totalMinor),
        breakdown: { item_total: paypalUsd(input.merchandiseMinor), shipping: paypalUsd(input.shippingMinor),
          ...(input.taxMinor > 0 && { tax_total: paypalUsd(input.taxMinor) }) },
      },
      shipping: { name: { full_name: input.name }, address: input.shippingAddress },
      items: input.lines.map(line => ({
        name: [...line.productName].slice(0, 127).join(""), category: "PHYSICAL_GOODS",
        unit_amount: paypalUsd(line.unitPriceMinor - line.unitDiscountMinor), quantity: String(line.quantity),
      })),
    }],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: "GriipBuddy", user_action: "PAY_NOW", shipping_preference: "SET_PROVIDED_ADDRESS",
          return_url: returnTo("return"), cancel_url: returnTo("cancel"),
        },
      },
    },
  }, input.attemptId));
  const link = data.links?.find(({ rel }) => rel === "payer-action" || rel === "approve");
  const approval = link ? new URL(link.href) : null;
  if (!approval || approval.origin !== "https://www.sandbox.paypal.com" ||
      approval.username || approval.password || approval.searchParams.get("token") !== data.id) {
    throw new Error("PayPal returned an unexpected approval link.");
  }
  return { providerOrderId: data.id, approvalUrl: approval.href };
}

function operationKey(operation: "capture" | "refund" | "refund-case", attemptId: string) {
  return createHash("sha256").update(`${operation}:${attemptId}`).digest("hex").slice(0, 36);
}

export async function inspectSandboxOrder(orderId: string) {
  return providerOrder.parse(await paypalRequest(`/v2/checkout/orders/${providerId.parse(orderId)}`));
}

export async function captureSandboxOrder(orderId: string, attemptId: string) {
  return providerOrder.parse(await paypalRequest(`/v2/checkout/orders/${providerId.parse(orderId)}/capture`, {}, operationKey("capture", attemptId)));
}

export async function refundSandboxCapture(captureId: string, attemptId: string) {
  return providerRefund.parse(await paypalRequest(`/v2/payments/captures/${providerId.parse(captureId)}/refund`, {}, operationKey("refund", attemptId)));
}

export async function refundSandboxCaseCapture(captureId: string, caseId: string, amountMinor: number) {
  return providerRefund.parse(await paypalRequest(`/v2/payments/captures/${providerId.parse(captureId)}/refund`, {
    amount: paypalUsd(amountMinor), custom_id: caseId,
  }, operationKey("refund-case", caseId)));
}

export async function inspectSandboxRefund(refundId: string) {
  return providerRefund.parse(await paypalRequest(`/v2/payments/refunds/${providerId.parse(refundId)}`));
}

export async function verifySandboxWebhook(event: object, headers: Headers) {
  const webhookId = paypalSandboxConfig()?.webhookId;
  if (!webhookId) return false;
  const signature = {
    auth_algo: headers.get("paypal-auth-algo"),
    cert_url: headers.get("paypal-cert-url"),
    transmission_id: headers.get("paypal-transmission-id"),
    transmission_sig: headers.get("paypal-transmission-sig"),
    transmission_time: headers.get("paypal-transmission-time"),
  };
  if (Object.values(signature).some(value => !value)) return false;
  const response = await paypalRequest("/v1/notifications/verify-webhook-signature", {
    ...signature, webhook_id: webhookId, webhook_event: event,
  });
  return z.object({ verification_status: z.literal("SUCCESS") }).safeParse(response).success;
}

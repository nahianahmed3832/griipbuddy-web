import type { OrderDocument } from "./order-document";
import { orderDocumentPdf } from "./order-document-pdf";
import { privateHeaders } from "@/lib/db/http";
import { currentMarket } from "@/lib/market-server";
import { getShopper } from "@/lib/marketplace/auth";
import { bdOrderHubConfig } from "@/lib/marketplace/bd-order-hub-bridge";
import { orderCenterEnabled } from "@/lib/marketplace/order-center-config";

const headers = { ...privateHeaders, "X-Robots-Tag": "noindex, nofollow" };

export function unavailableOrderDocument(status = 404) {
  return new Response(null, { status, headers });
}

export async function bangladeshDocumentShopper() {
  if (!bdOrderHubConfig() || (await currentMarket()).id !== "bd") return null;
  return getShopper();
}

export async function orderDocumentAccount() {
  const market = await currentMarket();
  if (!orderCenterEnabled(market.id)) return null;
  const shopper = await getShopper();
  return shopper ? { market, shopper } : null;
}

export async function downloadOrderDocument(data: OrderDocument) {
  const reference = data.reference.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 64);
  const filename = ["griipbuddy", reference, data.kind].filter(Boolean).join("-") + ".pdf";
  const pdf = await orderDocumentPdf(data);
  return new Response(new Uint8Array(pdf), { headers: {
    ...headers,
    "Content-Type": "application/pdf",
    "Content-Language": "en",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": `${pdf.byteLength}`,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
  } });
}

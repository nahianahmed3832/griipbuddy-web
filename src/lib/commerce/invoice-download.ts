import { formatMoney, type Market } from "../../config/markets.ts";
import { privateHeaders } from "../db/http.ts";

type InvoiceLine = { productName: string; variantName: string; sku: string; quantity: number; lineTotalMinor: number };
type InvoiceDocument = {
  audience: "customer" | "seller";
  reference: string;
  date: string;
  market: Market;
  status: string;
  recipient?: { title: string; lines: readonly string[] };
  items: readonly InvoiceLine[];
  totals: readonly { label: string; amountMinor: number }[];
  notes?: readonly string[];
};

function escapeHtml(value: string | number) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function invoiceAttachment(document: InvoiceDocument) {
  const { audience, reference, date, market, status, recipient, items, totals, notes } = document;
  const title = audience === "seller" ? "GriipBuddy seller invoice" : "GriipBuddy order invoice";
  const money = (amount: number) => escapeHtml(`${formatMoney(amount, market)} ${market.currency}`);
  const html = `<!doctype html><html lang="${escapeHtml(market.locale)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · ${escapeHtml(reference)}</title>
<style>
*{box-sizing:border-box}body{color:#24273b;font:15px/1.5 system-ui,sans-serif;margin:0}
main{width:min(100% - 2rem,55rem);margin:2rem auto}h1{line-height:1.15}h1,h2,p{overflow-wrap:anywhere}
table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{padding:.5rem;text-align:left;border-bottom:1px solid #ddd;overflow-wrap:anywhere}
thead{background:#f5f4f8}th:nth-child(2){width:15%}th:nth-child(3){width:26%}td:nth-child(3){font-variant-numeric:tabular-nums}
small{display:block}dt{font-weight:650}dd{margin:0;font-variant-numeric:tabular-nums}dl>div{display:grid;grid-template-columns:1fr 1fr;gap:.75rem;border-bottom:1px solid #ddd;padding:.45rem}
@media print{main{width:100%;margin:0}thead{display:table-header-group}tr,dl>div{break-inside:avoid}}
</style></head><body><main>
<h1>${title}</h1><p>Order ${escapeHtml(reference)} · ${escapeHtml(date)} · ${escapeHtml(market.name)} · ${escapeHtml(market.currency)}</p>
<p>${escapeHtml(status)}</p>
${recipient ? `<section><h2>${escapeHtml(recipient.title)}</h2><p>${recipient.lines.map(escapeHtml).join("<br>")}</p></section>` : ""}
<section><h2>Purchased items</h2><table><thead><tr><th scope="col">Item and SKU</th><th scope="col">Qty</th><th scope="col">Line total</th></tr></thead>
<tbody>${items.map(item => `<tr><th scope="row">${escapeHtml(item.productName)}<small>${escapeHtml(item.variantName)} · ${escapeHtml(item.sku)}</small></th>
<td>${escapeHtml(item.quantity)}</td><td>${money(item.lineTotalMinor)}</td></tr>`).join("")}</tbody></table></section>
<section><h2>Invoice totals</h2><dl>${totals.map(row => `<div><dt>${escapeHtml(row.label)}</dt><dd>${money(row.amountMinor)}</dd></div>`).join("")}</dl>
${notes?.map(note => `<p>${escapeHtml(note)}</p>`).join("") ?? ""}</section></main></body></html>`;
  const filename = reference.replace(/[^a-z0-9-]/gi, "-").slice(0, 72) || "order";
  return new Response(html, { headers: {
    ...privateHeaders,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Disposition": `attachment; filename="griipbuddy-${audience}-invoice-${filename}.html"`,
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  } });
}

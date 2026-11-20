import { marketConfiguration } from "../market-config.ts";
import { activityLabel, type OperationsReport } from "./operations-report.ts";

type ReportCell = string | number | null | { label: string; href: string };

export function reportTables(report: OperationsReport): { name: string; columns: string[]; rows: ReportCell[][] }[] {
  const { stock, orders, demand, input: { view } } = report;
  if (view === "stock" && stock) return [{ name: "Current physical stock pools",
    columns: ["Warehouse", "Stock owner", "SKU", "Product", "On hand", "Reserved", "Available", "Low-stock threshold", "Updated UTC"],
    rows: stock.rows.map(row => [row.location, row.organization, row.sku, row.product, row.onHand, row.reserved, row.available,
      row.threshold, row.updatedAt.toISOString()]) }];
  if (view === "demand" && demand) return [
    { name: "Search demand", columns: ["Safe search term", "Distinct sessions", "Zero-result searches"],
      rows: demand.terms.map(row => [row.term, row.sessions, row.zero]) },
    { name: "Wishlist demand", columns: ["Current market product", "Distinct add sessions"],
      rows: demand.wishlist.map(row => [row.name, row.sessions]) },
  ];
  if (!orders) return [];
  if (view === "activity") return [{ name: "Recorded activity", columns: ["Occurred UTC", "Event", "Order", "Amount in minor units"],
    rows: orders.activity.map(row => [row.at.toISOString(), activityLabel(row.kind), row.orderId && row.reference ?
      { label: row.reference, href: "/staff/orders/" + row.orderId } : null, row.amountMinor]) }];
  if (view === "products") {
    const columns = ["Current brand", "Current category", "Orders", "Units", "Merchandise in minor units"];
    return [
      { name: "Booked merchandise by product", columns: ["Recorded product", ...columns],
        rows: orders.products.map(row => [row.label, row.brand ?? null, row.department ?? null, row.orders, row.units, row.merchandiseMinor]) },
      { name: "Booked merchandise by variant", columns: ["Recorded product", "Recorded SKU", ...columns],
        rows: orders.variants.map(row => [row.label, row.sku ?? null, row.brand ?? null, row.department ?? null, row.orders, row.units, row.merchandiseMinor]) },
    ];
  }
  if (view === "organizations") return [{ name: "Booked merchandise by order-time organization", columns: [
    "Organization", "Orders with its lines", "Units", "Merchandise in minor units",
  ], rows: orders.organizations.map(row => [row.label, row.orders, row.units, row.merchandiseMinor]) }];
  return [{ name: "Activity by market reporting day", columns: [
    "Local date", "Orders placed", "Booked minor", "Delivered", "Cancelled", "Online paid minor", "COD collected minor",
    "Carrier remitted minor", "Refunded minor", "Returns requested", "Returns received", "Delivery refusals", "Online failures",
  ], rows: orders.daily.map(row => [row.day, row.orders, row.bookedMinor, row.delivered, row.cancellations, row.onlineMinor,
    row.codMinor, row.remittedMinor, row.refundedMinor, row.returnRequests, row.receivedReturns, row.refused,
    orders.failureEvidence ? row.paymentFailures : null]) }];
}

function csvCell(value: ReportCell) {
  if (value === null || typeof value === "number") return value ?? "";
  const text = typeof value === "object" ? value.label : value;
  const escaped = /^[\s\uFEFF]*[=+\-@\r\n\t]/u.test(text) ? "'" + text : text;
  return '"' + escaped.replaceAll('"', '""') + '"';
}

export function operationsCsv(report: OperationsReport, tableNumber = 1) {
  const table = reportTables(report)[tableNumber - 1];
  if (!table) return null;
  const { marketId, range, mode } = report.input;
  const { currency } = marketConfiguration(marketId);
  const headers = ["Market", "Currency", "Source cohort", "From local date", "Through local date", ...table.columns];
  const rows = table.rows.map(row => [marketId, currency, mode, range.from, range.to, ...row]);
  return [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

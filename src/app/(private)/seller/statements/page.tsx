import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { SignInGate } from "@/components/marketplace/session";
import { formatMoney, marketIds, type Market } from "@/config/markets";
import { currentMarket } from "@/lib/market-server";
import { isMarketSelectable, marketConfiguration } from "@/lib/market-config";
import { storefrontPath } from "@/config/storefront-path";
import { orderDate } from "@/lib/commerce/labels";
import { getShopper } from "@/lib/marketplace/auth";
import { sellerOrderRange } from "@/lib/marketplace/seller-order-range";
import { sellerShop } from "@/lib/marketplace/seller-orders";
import { sellerStatement, SellerStatementRangeError } from "@/lib/marketplace/seller-statements";
import { marketplaceMode } from "@/lib/release-config";
import styles from "./statement.module.css";

export const metadata = { title: "Seller statement" };

type Statement = NonNullable<Awaited<ReturnType<typeof sellerStatement>>>;
type StatementRow = Statement["rows"][number];
type StatementAmounts = Statement["totals"];

const pageSize = 20;
const deliveryLabels: Record<StatementRow["delivery"], string> = {
  PENDING: "Awaiting delivery", DELIVERED: "Delivered", REFUSED: "Delivery refused", CANCELLED: "Cancelled",
};
const collectionLabels: Record<StatementRow["collection"], string> = {
  PENDING: "Awaiting collection", COLLECTED: "Cash collected", VOIDED: "COD voided",
};
const remittanceLabels: Record<StatementRow["remittance"], string> = {
  UNRECORDED: "Awaiting remittance", DISCREPANCY: "Remittance discrepancy", MATCHED: "Money received from courier",
};

function StatementBreakdown({ amounts, market, courierFeesKnown = true }: { amounts: StatementAmounts; market: Market; courierFeesKnown?: boolean }) {
  const money = (amountMinor: number) => formatMoney(amountMinor, market);
  const deduction = (amountMinor: number) => money(amountMinor ? -amountMinor : 0);
  return <dl className={styles.breakdown}>
    <div><dt>Gross sales</dt><dd>{money(amounts.grossSalesMinor)}</dd></div>
    <div><dt>Discounts</dt><dd>{deduction(amounts.discountsMinor)}</dd></div>
    <div><dt>Return adjustments</dt><dd>{deduction(amounts.returnsMinor)}</dd></div>
    <div><dt>Commission</dt><dd>{deduction(amounts.commissionMinor)}</dd></div>
    <div><dt>Courier shipping fees</dt><dd>{courierFeesKnown ? deduction(amounts.courierFeesMinor) : "—"}</dd></div>
    <div><dt>Buyer shipping charged</dt><dd>{money(amounts.buyerShippingMinor)}</dd></div>
    <div><dt>Approved refunds</dt><dd>{money(amounts.approvedRefundsMinor)}</dd></div>
    <div><dt>Units returned</dt><dd>{amounts.returnedUnits}</dd></div>
  </dl>;
}

function StatementOrder({ order, market }: { order: StatementRow; market: Market }) {
  const money = (amountMinor: number) => formatMoney(amountMinor, market);
  return <li className={`mp-list-card ${styles.order}`}>
    <header className={styles.orderHeading}>
      <div><h3>{order.reference}</h3><p className="commerce-muted">Placed {orderDate(order.createdAt, market.id)}</p></div>
      <div className={styles.orderBalance}><span>Balance owed</span><strong>{money(order.balanceOwedMinor)}</strong></div>
    </header>
    <dl className={styles.progress} aria-label="COD progress">
      <div><dt>Delivery</dt><dd>{deliveryLabels[order.delivery]}</dd></div>
      <div><dt>Collection</dt><dd>{collectionLabels[order.collection]}</dd>
        {order.collection === "COLLECTED" && <dd>{money(order.collectedMinor)}</dd>}</div>
      <div><dt>Courier remittance</dt><dd>{order.remittance === "UNRECORDED" && order.collection !== "COLLECTED"
        ? "Unrecorded" : remittanceLabels[order.remittance]}</dd>
        {order.remittance === "MATCHED" && <dd>{money(order.remittedMinor)}</dd>}</div>
    </dl>
    <StatementBreakdown market={market} amounts={order} courierFeesKnown={order.remittance === "MATCHED"} />
  </li>;
}

export default async function SellerStatementPage({ searchParams }: {
  searchParams: Promise<{ from?: string | string[]; to?: string | string[]; page?: string | string[]; market?: string | string[] }>;
}) {
  if (!marketplaceMode()) notFound();
  const shopper = await getShopper();
  const heading = <h1 className="mp-page-title">Seller statement</h1>;
  if (!shopper) {
    return <div className="shell mp-page">{heading}<SignInGate>Sign in to view your seller statement.</SignInGate></div>;
  }

  const [query, selected] = await Promise.all([searchParams, currentMarket()]);
  const market = marketConfiguration(isMarketSelectable(query.market) ? query.market : selected.id);
  const money = (amountMinor: number) => formatMoney(amountMinor, market);
  const rate = new Intl.NumberFormat(market.defaultLocale, { style: "percent", maximumFractionDigits: 2 });
  const range = sellerOrderRange(query.from, query.to, new Date(), market.id);
  const result = range ? await sellerStatement(shopper.id, range).catch((error: unknown) => {
    if (error instanceof SellerStatementRangeError) return error;
    throw error;
  }) : null;
  const rangeError = result instanceof SellerStatementRangeError ? result.message : undefined;
  const statement = result instanceof SellerStatementRangeError ? null : result;
  const shop = statement?.shop ?? await sellerShop(shopper.id);
  if (!shop) redirect("/seller");

  const pageCount = Math.max(1, Math.ceil((statement?.rows.length ?? 0) / pageSize));
  const requestedPage = typeof query.page === "string" && /^\d{1,8}$/u.test(query.page) ? Number(query.page) : 1;
  const page = Math.max(1, Math.min(requestedPage, pageCount));
  const delivered = statement?.rows.filter(order => order.delivery === "DELIVERED").length ?? 0;
  const pageHref = (target: number) => `/seller/statements?${new URLSearchParams({
    market: market.id, from: range?.from ?? "", to: range?.to ?? "", page: String(target),
  })}`;

  return <div className="shell mp-page">
    <nav className="mp-panel-links" aria-label="Shop navigation">
      <Link href="/seller" prefetch={false}>Shop Manager</Link>
      <Link href="/seller/orders" prefetch={false}>Shop orders</Link>
    </nav>
    <header className="mp-shop-hero">
      <div className={styles.heading}>{heading}<p className={styles.hold}>Payouts on hold</p></div>
      <p>{shop.name} · {market.name} COD · Sample statement</p>
    </header>
    <form action={storefrontPath("/seller/statements")} method="get" className="mp-inline" aria-label="Filter statement by order date">
      <label>Market <select name="market" defaultValue={market.id}>
        {marketIds.filter(isMarketSelectable).map(id => <option key={id} value={id}>{marketConfiguration(id).name}</option>)}
      </select></label>
      <label>From <input name="from" type="date" min="1970-01-01" defaultValue={range?.from ?? (typeof query.from === "string" ? query.from : "")} /></label>
      <label>To <input name="to" type="date" min="1970-01-01" defaultValue={range?.to ?? (typeof query.to === "string" ? query.to : "")} /></label>
      <button type="submit" className="button button--outline">Apply filters</button>
      {!range && <p role="alert">Choose a valid date range. The From date must be on or before the To date.</p>}
      {rangeError && <p role="alert">{rangeError}</p>}
    </form>
    {statement && <>
      <section className="mp-section" aria-labelledby="statement-summary">
        <h2 id="statement-summary">Statement summary</h2>
        <p className="commerce-muted">Order dates use {market.timeZone}. Status reflects records through {orderDate(statement.asOf, market.id)}.</p>
        <div className={styles.summary}>
          <div className={styles.balance}>
            <h3>Balance owed</h3>
            <strong>{money(statement.totals.balanceOwedMinor)} <span>{statement.currency}</span></strong>
            <p>Balance includes merchandise from matched COD orders, less discounts, approved return adjustments, commission, and allocated courier fees.</p>
            <dl className={styles.breakdown}>
              <div><dt>Delivered orders</dt><dd>{delivered}</dd></div>
              <div><dt>Cash collected</dt><dd>{money(statement.totals.collectedMinor)}</dd></div>
              <div><dt>Money received from courier</dt><dd>{money(statement.totals.remittedMinor)}</dd></div>
              <div><dt>Merchandise awaiting remittance</dt><dd>{money(statement.totals.pendingMerchandiseMinor)}</dd></div>
            </dl>
          </div>
          <div className="mp-list-card">
            <StatementBreakdown market={market} amounts={statement.totals} />
            <p className="commerce-muted">Sample commission is {rate.format(statement.commissionBasisPoints / 10_000)} of merchandise after discounts and approved returns. Cash collected includes buyer shipping and tax. The balance starts with merchandise, and courier fees are shared across the order’s items.</p>
          </div>
        </div>
      </section>
      <section className="mp-section" aria-labelledby="statement-orders">
        <h2 id="statement-orders">Orders in this statement</h2>
        {statement.rows.length === 0 ? <p>No sample COD orders match these dates.</p> : <ul className={styles.orders}>
          {statement.rows.slice((page - 1) * pageSize, page * pageSize).map(order => <StatementOrder order={order} market={market} key={order.orderId} />)}
        </ul>}
        {pageCount > 1 && <nav className="mp-panel-links" aria-label="Statement pages">
          {page > 1 && <Link prefetch={false} href={pageHref(page - 1)}>Previous page</Link>}
          <span aria-current="page">Page {page} of {pageCount}</span>
          {page < pageCount && <Link prefetch={false} href={pageHref(page + 1)}>Next page</Link>}
        </nav>}
      </section>
    </>}
  </div>;
}

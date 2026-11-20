import { randomUUID } from "node:crypto";
import type { ReactNode } from "react";
import { saveSellerFinance, saveStaffSellerFinance } from "@/app/staff/seller-finance-actions";
import { formatMoney, type Market } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { orderDate } from "@/lib/commerce/labels";
import type { FinanceStatement } from "@/lib/marketplace/seller-finance";
import type { SellerOrderRange } from "@/lib/marketplace/seller-order-range";
import { FinanceForm } from "./seller-finance-form";
import styles from "./seller-finance.module.css";

const activityLabels = {
  ACCRUAL: "Sale recorded", HOLD: "Settlement held", RELEASE: "Released to available", REFUND: "Confirmed refund",
};
const stateLabels = {
  REQUESTED: "Requested", APPROVED: "Approved", REJECTED: "Rejected", PROCESSING: "Processing",
  RECONCILIATION: "Reconciliation needed", FAILED: "Failed", COMPLETED: "Completed",
  PENDING: "Awaiting review", VERIFIED: "Verified", REVOKED: "Revoked",
};

const balanceFields = [
  ["availableMinor", "Available"], ["pendingMinor", "Pending settlement"], ["heldMinor", "Held"],
  ["reservedMinor", "Reserved for payouts"], ["paidMinor", "Paid"],
] as const;

const activityFields = [
  ["grossMinor", "Gross merchandise"], ["discountMinor", "Discounts"], ["taxMinor", "Tax"],
  ["shippingMinor", "Shipping charged"], ["commissionMinor", "Commission"],
  ["feeMinor", "Fees"], ["refundedMinor", "Confirmed refunds"], ["netEarningsMinor", "Net earnings"],
] as const;

function badge(state: keyof typeof stateLabels) {
  return <span className={styles.badge} data-tone={state === "COMPLETED" || state === "VERIFIED" ? "positive"
    : state === "RECONCILIATION" || state === "PENDING" ? "warning" : undefined}>{stateLabels[state]}</span>;
}

export function FinanceScopeForm({ path, market, markets, selectedShop, shops, range, exportPath }: {
  path: string; market: Market; markets?: Market[]; selectedShop?: string; shops?: { id: string; name: string }[];
  range: SellerOrderRange | null; exportPath?: string;
}) {
  const query = new URLSearchParams({ market: market.id });
  if (selectedShop) query.set("shop", selectedShop);
  if (range) {
    query.set("from", range.from);
    query.set("to", range.to);
  }
  return <section className={styles.panel}>
    <form action={storefrontPath(path)} method="get" className={styles.filters} aria-label="Finance filters">
      {markets ? <label>Market<select name="market" defaultValue={market.id}>
        {markets.map(option => <option key={option.id} value={option.id}>{option.name} · {option.currency}</option>)}
      </select></label> : <input type="hidden" name="market" value={market.id} />}
      {shops && shops.length > 0 ? <label>Organization<select name="shop" defaultValue={selectedShop ?? ""}>
        <option value="">All organizations</option>
        {shops.map(shop => <option key={shop.id} value={shop.id}>{shop.name}</option>)}
      </select></label> : selectedShop && <input type="hidden" name="shop" value={selectedShop} />}
      <label>From<input name="from" type="date" defaultValue={range?.from ?? ""} min="1970-01-01" /></label>
      <label>To<input name="to" type="date" defaultValue={range?.to ?? ""} min="1970-01-01" /></label>
      <button type="submit" className={styles.primary}>Apply filters</button>
      {range && exportPath && <a className={styles.button} href={storefrontPath(exportPath + "?" + query)}>Download statement CSV</a>}
    </form>
    {!range && <p role="alert" className={styles.error}>Enter a valid From and To date to view the statement.</p>}
  </section>;
}

export function FinanceStatementView({ statement, market, staff = false }: {
  statement: FinanceStatement; market: Market; staff?: boolean;
}) {
  const money = (amount: number) => formatMoney(amount, market);
  const shopNames = new Map(statement.shops.map(shop => [shop.id, shop.name]));
  const policy = statement.policy;
  const percentage = (basisPoints: number) => new Intl.NumberFormat(market.locale, {
    style: "percent", maximumFractionDigits: 2,
  }).format(basisPoints / 10_000);
  return <>
    <section className={styles.panel} aria-labelledby="finance-balances">
      <div className={styles.heading}><h2 id="finance-balances">Current balances</h2><span>{statement.currency}</span></div>
      <dl className={styles.metrics}>
        {balanceFields.map(([field, label]) => <div key={field}><dt>{label}</dt><dd>{money(statement.totals[field])}</dd></div>)}
      </dl>
      {statement.totals.availableMinor < 0 && <p className={styles.warning}>Adjustments exceed current eligible funds. Future eligible earnings offset the difference.</p>}
    </section>
    <div className={styles.columns}>
      <section className={styles.panel} aria-labelledby="finance-activity">
        <h2 id="finance-activity">Statement activity</h2>
        <dl className={styles.values}>
          {activityFields.map(([field, label]) => <div key={field}><dt>{label}</dt><dd>{money(statement.totals[field])}</dd></div>)}
        </dl>
      </section>
      <section className={styles.panel} aria-labelledby="finance-policy">
        <h2 id="finance-policy">Effective test policy</h2>
        {!policy ? <p>No synthetic settlement policy is effective in this market.</p> : <dl className={styles.values}>
          <div><dt>Version</dt><dd>{policy.version}</dd></div>
          <div><dt>Effective</dt><dd>{orderDate(policy.effectiveAt, market.id)}</dd></div>
          <div><dt>Commission</dt><dd>{percentage(policy.commissionBps)}</dd></div>
          <div><dt>Processing fee</dt><dd>{percentage(policy.processingFeeBps)}</dd></div>
          <div><dt>Minimum hold</dt><dd>{policy.holdDays} days</dd></div>
        </dl>}
        <p className={styles.muted}>COD funds require matched courier remittance. Online funds require a separately recorded settlement release.</p>
      </section>
    </div>
    <section className={styles.panel} aria-labelledby="finance-entry-history">
      <h2 id="finance-entry-history">Statement entries</h2>
      {statement.entries.length === 0 ? <p>No entries match this period.</p> : <div className={styles.rows}>
        {statement.entries.map(entry => <details className={styles.row} key={entry.id}>
          <summary>
            <span><strong>{entry.orderReference}</strong><small>{staff && shopNames.get(entry.shopId)}{staff && " · "}{orderDate(entry.sourceAt, market.id)}</small></span>
            <span>{activityLabels[entry.kind]}<small>Policy v{entry.policyVersion}</small></span>
            <strong>{money(entry.netMinor)}</strong>
          </summary>
          <dl className={styles.values}>
            <div><dt>Gross merchandise</dt><dd>{money(entry.grossMinor)}</dd></div>
            <div><dt>Discount</dt><dd>{money(entry.discountMinor)}</dd></div>
            <div><dt>Tax</dt><dd>{money(entry.taxMinor)}</dd></div>
            <div><dt>Shipping</dt><dd>{money(entry.shippingMinor)}</dd></div>
            <div><dt>Commission</dt><dd>{money(entry.commissionMinor)}</dd></div>
            <div><dt>Fee</dt><dd>{money(entry.feeMinor)}</dd></div>
            <div><dt>Confirmed refund</dt><dd>{money(entry.refundMinor)}</dd></div>
            <div><dt>Record created</dt><dd>{orderDate(entry.createdAt, market.id)}</dd></div>
            <div><dt>Source record</dt><dd>{entry.sourceId}</dd></div>
          </dl>
        </details>)}
      </div>}
    </section>
  </>;
}

export function SellerFinanceControls({ statement, market, shopId, canManageDestinations, canRequestPayout }: {
  statement: FinanceStatement; market: Market; shopId: string; canManageDestinations: boolean; canRequestPayout: boolean;
}) {
  const verified = statement.destinations.filter(destination => destination.state === "VERIFIED");
  const endpoint = saveSellerFinance.bind(null, shopId, market.id);
  return <>
    <div className={styles.columns}>
      <section className={styles.panel} aria-labelledby="finance-destinations">
        <h2 id="finance-destinations">Test payout destinations</h2>
        {statement.destinations.length === 0 ? <p>No test destinations saved.</p> : <ul className={styles.rows}>
          {statement.destinations.map(destination => <li key={destination.id} className={styles.row}>
            <div className={styles.dataLine}><span><strong>{destination.label}</strong><small>{destination.maskedReference}</small></span>{badge(destination.state)}</div>
            {canManageDestinations && destination.state !== "REVOKED" && <FinanceForm action={endpoint.bind(null, "destination-revoke")} submit="Revoke test destination">
              <input type="hidden" name="destinationId" value={destination.id} />
            </FinanceForm>}
          </li>)}
        </ul>}
        {canManageDestinations && <details className={styles.disclosure}>
          <summary>Add a test destination</summary>
          <FinanceForm action={endpoint.bind(null, "destination-submit")} submit="Submit for verification" operationId={randomUUID()}>
            <label>Destination label<input name="label" required maxLength={60} autoComplete="off" /></label>
            <label>Synthetic reference<input name="testReference" placeholder="TEST-DEMO" required minLength={9} maxLength={53}
              pattern={"TEST-[A-Za-z0-9_\\-]{4,48}"} autoComplete="off" /></label>
            <p className={styles.muted}>Use an invented TEST- reference. Do not enter account or bank details.</p>
          </FinanceForm>
        </details>}
      </section>
      <section className={styles.panel} aria-labelledby="finance-new-payout">
        <h2 id="finance-new-payout">Request a test payout</h2>
        {!canRequestPayout ? <p>Request permission is required to submit a test payout.</p>
          : verified.length === 0 ? <p>Use a verified test destination to continue.</p>
            : statement.totals.availableMinor <= 0 ? <p>No funds are available for a test payout.</p>
              : <FinanceForm action={endpoint.bind(null, "payout-request")} submit="Submit test payout" operationId={randomUUID()}>
                <label>Verified destination<select name="destinationId" required>
                  {verified.map(destination => <option key={destination.id} value={destination.id}>{destination.label} · {destination.maskedReference}</option>)}
                </select></label>
                <label>Amount ({market.currency})<input name="amount" required type="text" inputMode="decimal" autoComplete="off" /></label>
              </FinanceForm>}
      </section>
    </div>
    <FinancePayouts statement={statement} market={market} />
  </>;
}

export function StaffFinanceControls({ statement, market }: { statement: FinanceStatement; market: Market }) {
  const endpoint = saveStaffSellerFinance.bind(null, market.id);
  const shopNames = new Map(statement.shops.map(shop => [shop.id, shop.name]));
  return <>
    <div className={styles.columns}>
      <section className={styles.panel} aria-labelledby="finance-policy-editor">
        <h2 id="finance-policy-editor">Publish a synthetic policy</h2>
        <FinanceForm action={endpoint.bind(null, "policy-create")} submit="Publish test policy" operationId={randomUUID()}>
          <label>Commission (basis points)<input name="commissionBps" required type="number" step={1} min={0} max={10_000} /></label>
          <label>Processing fee (basis points)<input name="processingFeeBps" required type="number" step={1} min={0} max={10_000} /></label>
          <label>Hold days<input name="holdDays" required type="number" step={1} min={0} max={180} /></label>
          <label>Effective time (UTC, optional)<input name="effectiveAt" type="datetime-local" /></label>
          <p className={styles.muted}>Leave the effective time blank to publish now. Recorded entries keep their original policy versions.</p>
        </FinanceForm>
      </section>
      <section className={styles.panel} aria-labelledby="finance-order-reconcile">
        <h2 id="finance-order-reconcile">Reconcile source records</h2>
        <FinanceForm action={endpoint.bind(null, "reconcile-order")} submit="Reconcile order">
          <label>Order ID<input name="orderId" required autoComplete="off" maxLength={36} /></label>
        </FinanceForm>
        <details className={styles.disclosure}>
          <summary>Record online settlement release</summary>
          <FinanceForm action={endpoint.bind(null, "online-release")} submit="Record test release" operationId={randomUUID()}>
            <label>Order ID<input name="orderId" required autoComplete="off" maxLength={36} /></label>
            <label>Synthetic release reference<input name="testReference" required placeholder="TEST-RELEASE" minLength={9} maxLength={53}
              pattern={"TEST-[A-Za-z0-9_\\-]{4,48}"} autoComplete="off" /></label>
            <Reason />
          </FinanceForm>
        </details>
      </section>
    </div>
    <section className={styles.panel} aria-labelledby="finance-review-destination">
      <h2 id="finance-review-destination">Destination review</h2>
      {statement.destinations.length === 0 ? <p>No test destinations in this market.</p> : <ul className={styles.rows}>
        {statement.destinations.map(destination => <li className={styles.row} key={destination.id}>
          <div className={styles.dataLine}><span><strong>{destination.label}</strong><small>{shopNames.get(destination.shopId)} · {destination.maskedReference}</small></span>{badge(destination.state)}</div>
          {destination.state !== "REVOKED" && <details className={styles.disclosure}>
            <summary>{destination.state === "PENDING" ? "Review destination" : "Revoke destination"}</summary>
            <FinanceForm action={endpoint.bind(null, "destination-review")} submit="Record destination decision">
              <input type="hidden" name="destinationId" value={destination.id} />
              <label>Decision<select name="decision" required>
                {destination.state === "PENDING" && <option value="VERIFY">Verify test destination</option>}
                <option value="REVOKE">Revoke</option>
              </select></label>
              <Reason />
            </FinanceForm>
          </details>}
        </li>)}
      </ul>}
    </section>
    <FinancePayouts statement={statement} market={market} staff />
    <section className={styles.panel} aria-labelledby="finance-audit">
      <h2 id="finance-audit">Recent finance audit</h2>
      {statement.audit.length === 0 ? <p>No finance audit records in this scope.</p> : <ul className={styles.rows}>
        {statement.audit.map(record => <li key={record.id} className={styles.row}>
          <div className={styles.dataLine}>
            <span><strong>{record.action.toLowerCase().replaceAll("_", " ")}</strong>
              <small>{record.actorKind === "staff" ? "Finance staff" : "Seller"}{record.shopId && shopNames.has(record.shopId) ? ` · ${shopNames.get(record.shopId)}` : ""} · {orderDate(record.createdAt, market.id)}</small></span>
          </div>
          <small>Record {record.recordId}</small>
          {record.reason && <p>{record.reason}</p>}
        </li>)}
      </ul>}
    </section>
  </>;
}

function Reason() {
  return <label>Reason<textarea name="reason" required rows={2} minLength={3} maxLength={300} /></label>;
}

function FinancePayouts({ statement, market, staff }: { statement: FinanceStatement; market: Market; staff?: boolean }) {
  const shops = new Map(statement.shops.map(shop => [shop.id, shop.name]));
  const destinations = new Map(statement.destinations.map(destination => [destination.id, destination]));
  const endpoint = saveStaffSellerFinance.bind(null, market.id);
  const control = (payout: FinanceStatement["payouts"][number]): ReactNode => {
    const common = <><input type="hidden" name="payoutId" value={payout.id} /><Reason /></>;
    if (payout.status === "REQUESTED") return <details className={styles.disclosure}>
      <summary>Review test payout</summary>
      <FinanceForm action={endpoint.bind(null, "payout-review")} submit="Save payout review">
        <label>Decision<select name="decision" required><option value="APPROVE">Approve</option><option value="REJECT">Reject</option></select></label>
        {common}
      </FinanceForm>
    </details>;
    if (payout.status === "APPROVED") return <><details className={styles.disclosure}>
      <summary>Process test payout</summary>
      <FinanceForm action={endpoint.bind(null, "payout-process")} submit="Record simulated attempt">
        <label>Simulated outcome<select name="outcome" required>
          <option value="CONFIRMED">Confirmed</option><option value="FAILED">Failed</option><option value="TIMEOUT">Timed out</option>
        </select></label>
        {common}
      </FinanceForm>
    </details><details className={styles.disclosure}>
      <summary>Reject approved test payout</summary>
      <FinanceForm action={endpoint.bind(null, "payout-review")} submit="Reject test payout">
        <input type="hidden" name="decision" value="REJECT" />
        {common}
      </FinanceForm>
    </details></>;
    if (payout.status === "PROCESSING" || payout.status === "RECONCILIATION") return <details className={styles.disclosure}>
      <summary>Reconcile test payout</summary>
      <FinanceForm action={endpoint.bind(null, "payout-reconcile")} submit="Save reconciliation">
        <input type="hidden" name="attemptReference" value={payout.attemptReference ?? ""} />
        <p className={styles.muted}>Recorded attempt {payout.attemptReference}</p>
        <label>Observed outcome<select name="outcome" required><option value="CONFIRMED">Confirmed</option><option value="FAILED">Failed</option></select></label>
        {common}
      </FinanceForm>
    </details>;
    return null;
  };
  return <section className={styles.panel} aria-labelledby="finance-payout-history">
    <h2 id="finance-payout-history">{staff ? "Test payout queue" : "Test payout history"}</h2>
    {statement.payouts.length === 0 ? <p>No test payout records.</p> : <ul className={styles.rows}>
      {statement.payouts.map(payout => {
        const destination = destinations.get(payout.destinationId);
        return <li key={payout.id} className={styles.row}>
          <div className={styles.dataLine}><span><strong>{formatMoney(payout.amountMinor, market)}</strong>
            <small>{staff && shops.get(payout.shopId)}{staff && " · "}{orderDate(payout.createdAt, market.id)}</small>
            {destination && <small>{destination.label} · {destination.maskedReference}</small>}</span>{badge(payout.status)}</div>
          {staff && payout.reason && <p>{payout.reason}</p>}
          {staff && control(payout)}
        </li>;
      })}
    </ul>}
  </section>;
}

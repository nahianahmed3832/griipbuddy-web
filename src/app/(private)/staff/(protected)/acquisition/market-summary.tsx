import type { Market } from "@/config/markets";
import type { marketBehavior, marketCommerce } from "@/lib/measurement/market-summary";
import type { summarizeForecast } from "@/lib/measurement/forecast";

export const count = (value: number) => new Intl.NumberFormat("en").format(value);
export const share = (numerator: number, denominator: number) => denominator ? `${(numerator * 100 / denominator).toFixed(1)}%` : "—";

export function money(amount: bigint, market: Pick<Market, "locale" | "currency" | "minorDigits">) {
  const scale = 10n ** BigInt(market.minorDigits);
  const absolute = amount < 0n ? -amount : amount;
  const integer = new Intl.NumberFormat(market.locale).format(absolute / scale);
  const decimal = market.minorDigits ? "." + String(absolute % scale).padStart(market.minorDigits, "0") : "";
  return `${market.currency} ${amount < 0n ? "−" : ""}${integer}${decimal}`;
}

export function MarketSummary({ market, test, behavior, commerce, forecast }: {
  market: Market; test: boolean; behavior: ReturnType<typeof marketBehavior>; commerce: ReturnType<typeof marketCommerce>;
  forecast: ReturnType<typeof summarizeForecast>;
}) {
  const terms = behavior.terms.filter(([, term]) => test || term.sessions >= 3).slice(0, 10);
  const zeroTerms = behavior.terms.filter(([, term]) => term.zeros && (test || term.sessions >= 3))
    .sort(([a, left], [b, right]) => right.zeros - left.zeros || a.localeCompare(b)).slice(0, 10);
  const { finance } = commerce;
  return <>
    <section className="commerce-panel commerce-stack" aria-labelledby="market-funnel">
      <h2 id="market-funnel">Shopping funnel</h2>
      <dl className="acquisition-scores">
        <div><dt>Qualified sessions</dt><dd>{count(behavior.qualified)}</dd></div>
        <div><dt>Product to cart</dt><dd>{share(behavior.productToCart, behavior.productViews)}</dd><dd>{count(behavior.productToCart)} of {count(behavior.productViews)} product-view sessions</dd></div>
        <div><dt>Checkout to order</dt><dd>{share(behavior.checkoutToOrder, behavior.checkoutStarts)}</dd><dd>{count(behavior.checkoutToOrder)} of {count(behavior.checkoutStarts)} checkout sessions</dd></div>
        <div><dt>Checkout failures</dt><dd>{count(behavior.checkoutFailures)}</dd><dd>Recorded storefront errors</dd></div>
      </dl>
      <p className="commerce-muted">Sessions are grouped by their first measured shopping activity in {market.name}. A product conversion requires a view followed by an addition of the same product within the session. Checkout conversion requires an authoritative order linked to the measured checkout session.</p>
    </section>
    <section className="commerce-panel commerce-stack" aria-labelledby="market-search">
      <h2 id="market-search">Search demand</h2>
      <dl className="acquisition-scores">
        <div><dt>Searches</dt><dd>{count(behavior.searches)}</dd></div>
        <div><dt>Zero-result searches</dt><dd>{count(behavior.zeros)}</dd><dd>{share(behavior.zeros, behavior.searches)} of searches</dd></div>
        <div><dt>Filter and sort changes</dt><dd>{count(behavior.filterChanges)}</dd></div>
      </dl>
      {(terms.length > 0 || zeroTerms.length > 0) && <div className="acquisition-search">
        <SearchTerms label="Most searched terms" terms={terms} />
        <SearchTerms label="Top zero-result terms" terms={zeroTerms} />
      </div>}
      {!test && <p className="commerce-muted">Search totals include redacted and low-volume queries. A term appears after searches in three distinct sessions in this report window.</p>}
    </section>
    <section className="commerce-panel commerce-stack" aria-labelledby="market-orders">
      <h2 id="market-orders">Order, payment and delivery outcomes</h2>
      <p>All classified storefront orders placed during this period, with outcomes through the report refresh time. Provider-confirmed failures are counted separately by when they occurred.</p>
      <p>Order evidence · {count(commerce.evidence.production)} production · {count(commerce.evidence.sandbox)} sandbox · {count(commerce.evidence.fixture)} fixture · {count(commerce.evidence.unknown)} historical without an evidence type.</p>
      <dl className="acquisition-scores">
        <div><dt>Orders placed</dt><dd>{count(commerce.accepted)}</dd></div>
        <div><dt>Payment failures</dt><dd>{commerce.providerFailures == null ? "Unavailable" : count(commerce.providerFailures)}</dd><dd>{commerce.providerFailures === null ? "No configured online outcome evidence for this dataset" : "Provider-confirmed transitions"}</dd></div>
        <div><dt>Online payments captured</dt><dd>{count(commerce.paid)}</dd></div>
        <div><dt>Captured share of reported online outcomes</dt><dd>{commerce.providerFailures === null ? "Unavailable" : share(commerce.paidInWindow, commerce.paidInWindow + commerce.providerFailures)}</dd><dd>Capture and failure evidence within the selected dates can include the same retried attempt.</dd></div>
        <div><dt>Delivered orders</dt><dd>{count(commerce.delivered)}</dd></div>
        <div><dt>COD orders placed</dt><dd>{count(commerce.codOrders)}</dd></div>
        <div><dt>COD awaiting collection</dt><dd>{count(commerce.codAwaiting)}</dd></div>
        <div><dt>COD collected</dt><dd>{count(commerce.codCollected)}</dd></div>
        <div><dt>COD remittances matched</dt><dd>{count(finance.remittanceOrders)}</dd></div>
        <div><dt>Delivery refusals</dt><dd>{count(commerce.deliveryRefused)}</dd></div>
        <div><dt>Cancelled orders</dt><dd>{count(commerce.cancelled)}</dd></div>
        <div><dt>Orders with received returns</dt><dd>{count(commerce.returned)}</dd></div>
        <div><dt>Orders with verified refunds</dt><dd>{count(commerce.refunded)}</dd></div>
      </dl>
    </section>
    <section className="commerce-panel commerce-stack" aria-labelledby="market-contribution">
      <h2 id="market-contribution">Contribution profit</h2>
      {commerce.contribution.total === null
        ? <p><strong>Unavailable.</strong> Reconciled financial evidence is complete for {commerce.contribution.verified} of {commerce.accepted} orders.</p>
        : <p><strong>{money(commerce.contribution.total, market)}</strong> across {commerce.contribution.verified} verified orders.</p>}
      {commerce.contribution.missing.length > 0 && <ul>
        {commerce.contribution.missing.map(([input, orders]) => <li key={input}>{input} missing for {orders} {orders === 1 ? "order" : "orders"}</li>)}
      </ul>}
      <div className="acquisition-table" role="region" aria-label="Contribution data available" tabIndex={0}><table>
        <thead><tr><th scope="col">Financial input</th><th scope="col">Amount or availability</th></tr></thead>
        <tbody>
          <tr><th scope="row">Booked merchandise after discounts, before tax</th><td>
            {finance.merchandiseCovered === commerce.accepted ? money(finance.merchandiseBooked, market) :
              `Unavailable for ${commerce.accepted - finance.merchandiseCovered} orders`}
          </td></tr>
          <tr><th scope="row">Delivery charged at booking</th><td>
            {finance.deliveryCovered === commerce.accepted ? money(finance.deliveryCharged, market) :
              `Unavailable for ${commerce.accepted - finance.deliveryCovered} orders`}
          </td></tr>
          <tr><th scope="row">Verified online captures</th><td>{money(finance.prepaidCaptured, market)}</td></tr>
          <tr><th scope="row">Recorded COD collections</th><td>{money(finance.codCollected, market)}</td></tr>
          <tr><th scope="row">Matched COD remittance net</th><td>{finance.remittanceOrders ? money(finance.remittanceNet, market) : "No matched remittance evidence"}</td></tr>
          <tr><th scope="row">Deductions on matched COD remittances</th><td>{finance.remittanceOrders ? money(finance.remittanceDeductions, market) : "No matched remittance evidence"}</td></tr>
        </tbody>
      </table></div>
      <p className="commerce-muted">Booked amounts include orders that may later cancel or return. Capture, collection and remittance are separate stages and can appear in multiple rows.</p>
    </section>
    <section className="commerce-panel commerce-stack">
      <h2>Market order forecast</h2>
      {forecast.forecast
        ? <p>Estimated {forecast.forecast.estimate} booked orders per upcoming week. The four completed local weeks ranged from {forecast.forecast.observedLow} to {forecast.forecast.observedHigh} orders. The last-week holdout error was {forecast.forecast.lastWeekError} orders.</p>
        : <p>Insufficient history. The four completed local weeks contain {forecast.observations} booked orders. The forecast requires at least {forecast.minimumOrders}.</p>}
    </section>
  </>;
}

function SearchTerms({ label, terms }: {
  label: string;
  terms: ReturnType<typeof marketBehavior>["terms"];
}) {
  return <div className="acquisition-table" role="region" aria-label={`${label} table`} tabIndex={0}><table>
    <caption>{label}</caption>
    <thead><tr><th scope="col">Term</th><th scope="col">Searches</th><th scope="col">Zero results</th></tr></thead>
    <tbody>{terms.length ? terms.map(([term, stat]) => <tr key={term}>
      <th scope="row">{term}</th><td>{count(stat.searches)}</td><td>{count(stat.zeros)}</td>
    </tr>) : <tr><td colSpan={3}>No terms available</td></tr>}</tbody>
  </table></div>;
}

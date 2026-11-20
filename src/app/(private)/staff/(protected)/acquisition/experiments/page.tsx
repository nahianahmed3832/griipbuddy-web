import Link from "next/link";
import { notFound } from "next/navigation";
import { isMarketId, type Market } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import type { experimentResults } from "@/lib/catalog/recommendation-experiment-analysis";
import { recommendationExperimentEnabled } from "@/lib/catalog/recommendation-experiment-data";
import { recommendationExperimentPlan as plan } from "@/lib/catalog/recommendation-experiment-plan";
import { recommendationExperimentReport } from "@/lib/catalog/recommendation-experiment-report";
import { reportFailure } from "@/lib/db/observability";
import { marketConfiguration } from "@/lib/market-config";
import { requireStaff } from "@/lib/staff/access";
import { staffMarketIds } from "@/lib/staff/market-access";
import { count, money, share } from "../market-summary";
import "../acquisition.css";

export const metadata = { title: "Recommendation experiment", robots: { index: false, follow: false } };

type Arm = ReturnType<typeof experimentResults>["control"];
type Interval = readonly [number, number] | null;
const confidence = (interval: Interval) => interval && `${(interval[0] * 100).toFixed(1)}% to ${(interval[1] * 100).toFixed(1)}%`;

function rate(events: number, sample: number, interval: Interval) {
  return <>{share(events, sample)} <small>({events} of {sample}{interval && `, 95% interval ${confidence(interval)}`})</small></>;
}

function revenuePerVisitor(arm: Arm, market: Market) {
  return arm.mature ? money((arm.collected + BigInt(Math.floor(arm.mature / 2))) / BigInt(arm.mature), market) : "Awaiting outcome window";
}

function contribution(arm: Arm, market: Market) {
  const { total, verified, missing } = arm.contribution;
  if (total !== null) return `${money(total, market)} across ${count(verified)} orders`;
  return `Unavailable. ${verified} of ${arm.matureOrders} orders have verified inputs${missing.length ?
    `. ${missing.map(([name, affected]) => `${name} missing for ${count(affected)}`).join(". ")}` : ""}.`;
}

export default async function ExperimentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff();
  const allowed = await staffMarketIds(staff.id, "reporting");
  const params = await searchParams;
  if (!allowed.length || (params.market !== undefined && (!isMarketId(params.market) || !allowed.includes(params.market)))) notFound();
  const market = marketConfiguration(isMarketId(params.market) ? params.market : allowed[0]);
  const test = params.scope === "test";
  const scope = test ? "test" : "live";
  const report = await recommendationExperimentReport({ marketId: market.id, test,
    from: typeof params.from === "string" ? params.from : undefined,
    to: typeof params.to === "string" ? params.to : undefined,
  }).catch(error => {
    reportFailure("recommendations.experiment-report", undefined, error);
    return null;
  });
  const results = report?.kind === "ready" ? report.results : null;
  return <div className="acquisition">
    <header className="commerce-intro">
      <p className="eyebrow">Market reporting</p>
      <h1 className="display-type">Recommendation experiment</h1>
      <p>Compare the effect of behavioral recommendations in the homepage recommendation slot in {market.name}.</p>
      <Link href={`/staff/acquisition?market=${market.id}&scope=${scope}`}>Back to acquisition</Link>
    </header>
    <section className="commerce-panel commerce-stack">
      <h2>{test ? "Staging and test data" : "Production data"}</h2>
      <p>{test ? `Test assignments are ${recommendationExperimentEnabled() ? "enabled" : "disabled"} in this environment. Test outcomes are labeled fixture or sandbox.` : "Production enrollment is disabled."}</p>
      <form action={storefrontPath("/staff/acquisition/experiments")} className="commerce-form">
        <div className="commerce-fields">
          <label>Dataset<select name="scope" defaultValue={scope}><option value="live">Production</option><option value="test">Staging and test</option></select></label>
          <label>Market<select name="market" defaultValue={market.id}>
            {allowed.map(id => <option key={id} value={id}>{marketConfiguration(id).name}</option>)}
          </select></label>
          <label>Assigned from<input name="from" type="date" defaultValue={report?.window.from} /></label>
          <label>Assigned through<input name="to" type="date" defaultValue={report?.window.to} /></label>
        </div>
        <button className="button button--outline" type="submit">Update results</button>
      </form>
      <p className="commerce-muted">Choose up to seven assignment days from the last 30 days in {market.timeZone}.</p>
    </section>
    <section className="commerce-panel commerce-stack">
      <h2>Analysis plan</h2>
      <p>{plan.id}. Consenting shopping journeys are assigned 50/50 within each market. Control uses {plan.control}. The personalized arm uses {plan.personalized}.</p>
      <p>The primary metric is the share of assigned journeys with at least one verified capture or COD collection. Eligible orders are booked within {plan.bookingDays} days of assignment and before measurement consent expires. Collection is measured through day {plan.collectionDays}, and fulfillment and returns through day {plan.fulfillmentDays}.</p>
      <p>Analysis includes assigned journeys that never see the slot. Visible exposure is reported separately. Both arms need at least {count(plan.minMaturePerArm)} mature journeys and {plan.minCompletedPerArm} completed purchases before review.</p>
    </section>
    {report === null && <p role="status">Experiment results are temporarily unavailable.</p>}
    {report?.kind === "window-too-large" && <p role="status">This selection exceeds the report limit. Choose a shorter date range.</p>}
    {results && <section className="commerce-panel commerce-stack">
      <h2>Results in {market.currency}</h2>
      <p role="status">{results.interpretation === "insufficient-sample" ? "Insufficient mature data for a decision." :
        results.interpretation === "allocation-review" ? "Review the assignment split before interpreting results." :
          results.interpretation === "configuration-review" ? "Review configuration changes before interpreting results." : "Eligible for analysis review."}</p>
      <p>Commerce evidence in this cohort is {results.evidence.length ? results.evidence.join(" and ") : "unavailable"}.</p>
      {results.hasMixedVersions && <p>Multiple homepage or recommendation versions were exposed during this cohort.</p>}
      {results.liftInterval && <p>Personalized minus control purchase conversion has an approximate 95% range of {(results.liftInterval[0] * 100).toFixed(1)} to {(results.liftInterval[1] * 100).toFixed(1)} percentage points.</p>}
      <div className="commerce-table-wrap">
        <table className="commerce-table">
          <thead><tr><th scope="col">Measure</th><th scope="col">Control</th><th scope="col">Personalized</th></tr></thead>
          <tbody>
            {([
              ["Assigned journeys", (arm: Arm) => count(arm.assigned)],
              ["Visible exposures", (arm: Arm) => count(arm.exposed)],
              ["Exposed recommendation versions", (arm: Arm) => arm.versions.join(", ") || "—"],
              ["Purchase and collection window pending", (arm: Arm) => count(arm.awaitingCollection)],
              ["Completed-purchase conversion", (arm: Arm) => rate(arm.completed, arm.mature, arm.conversionInterval)],
              ["Collected revenue per eligible visitor", (arm: Arm) => revenuePerVisitor(arm, market)],
              ["Fulfillment window pending", (arm: Arm) => count(arm.awaitingFulfillment)],
              ["Orders delivered by day 21", (arm: Arm) => rate(arm.delivered, arm.matureOrders, arm.deliveryInterval)],
              ["Delivered orders with returns received by day 21", (arm: Arm) => rate(arm.returns, arm.delivered, arm.returnInterval)],
              ["COD collected by day 21", (arm: Arm) => count(arm.codCollected)],
              ["COD remittances matched by day 21", (arm: Arm) => count(arm.codRemitted)],
              ["Contribution profit", (arm: Arm) => contribution(arm, market)],
              ["Recommendation server latency p95", (arm: Arm) => arm.p95Ms === null ? "Unavailable" : `${arm.p95Ms} ms (${count(arm.latencySamples)} samples)`],
              ["Checkout error rate", (arm: Arm) => rate(arm.checkoutErrors, arm.checkouts, arm.checkoutErrorInterval)],
              ["Journeys with verified payment failures", (arm: Arm) => arm.paymentFailures === null ? "Unavailable" : count(arm.paymentFailures)],
            ] as const).map(([label, value]) => <tr key={label}><th scope="row">{label}</th><td>{value(results.control)}</td><td>{value(results.personalized)}</td></tr>)}
          </tbody>
        </table>
      </div>
      <p className="commerce-muted">Collected revenue uses gross verified collections and captures in {market.currency}. Checkout errors reflect recorded shopper journeys. Latency uses the first timed server response per assigned journey. Mature rates are shown with approximate 95% Wilson intervals when a denominator is available.</p>
    </section>}
  </div>;
}

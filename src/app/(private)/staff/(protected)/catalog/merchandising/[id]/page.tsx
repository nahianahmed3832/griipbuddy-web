import Link from "next/link";
import { notFound } from "next/navigation";
import { MerchandisingForm } from "@/components/merchandising-forms";
import { ProductEditor } from "@/components/product-editor";
import { ProductDetail } from "@/components/product-detail";
import { ProductGrid } from "@/components/product-grid";
import { formatMoney, getMarket, markets, type MarketId } from "@/config/markets";
import { productCards } from "@/lib/catalog/listing";
import { getDb } from "@/lib/db/client";
import { requireStaff } from "@/lib/staff/access";
import { catalogChoices } from "@/lib/staff/catalog";
import { approvalCurrent, candidate, intendedMarkets, launchDrafts, previewCatalog, pricing, readiness, reviewedFacts } from "@/lib/staff/merchandising";
import { merchandisingEnabled } from "@/lib/staff/merchandising-config";
import { workStatus } from "@/lib/staff/merchandising-worker";
import "../merchandising.css";

const home = "/staff/catalog/merchandising";
export const metadata = { title: "Candidate review", robots: { index: false, follow: false } };

export default async function CandidateReview({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ market?: string; view?: string; task?: string; intent?: string }>;
}) {
  const staff = await requireStaff();
  if (staff.role !== "OWNER" || !merchandisingEnabled()) notFound();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const view = await candidate(staff.id, id);
  if (!view) notFound();
  const db = getDb();
  const market = getMarket(query.market ?? intendedMarkets(view.draft)[0]);
  const [status, catalog, choices, task, history] = await Promise.all([
    readiness(db, view), previewCatalog(db, view, market.id), catalogChoices(staff.id),
    query.task ? workStatus(staff.id, id, query.task).catch(() => null) : null,
    db.auditEvent.findMany({ where: { action: "MERCHANDISING_REVIEW", target: id },
      orderBy: { createdAt: "desc" }, take: 12, select: { actorId: true, createdAt: true, changes: true } }),
  ]);
  const approved = approvalCurrent(view, status);
  const scope = status.markets.filter((item) => item.ready).map((item) => item.market).join(",");
  const launches = await launchDrafts(db, view, approved);
  const privateDraft = view.ownsDraft && status.current?.publication !== "ACTIVE";
  const { product, evidence } = view.draft;
  const href = home + "/" + id;
  const title = view.publishedAt ? "Published to staging" : view.decision === "rejected" ? "Rejected" : approved
    ? view.stagedRevision === view.revision ? "Catalog draft saved" : "Approved" :
      view.decision === "approved" ? "Approval needs refresh" : status.ready ? "Ready for review" : "Needs information";
  const identity = { candidate: id, revision: String(view.revision) };
  const monetary = (value: number | null, marketId: MarketId) => value === null ? "Unavailable" : formatMoney(value, markets[marketId]);
  const liveDiff = view.baseline ? Object.entries(product).filter(([key, value]) => key !== "publication" &&
    JSON.stringify(value) !== JSON.stringify(view.baseline?.[key as keyof typeof product])) : [];
  const lastRun = task?.latest?.output;
  const direction = query.intent === "launch" ? "launch" : "listing";

  return <>
    <div className="commerce-intro">
      <Link className="text-link" href={home}>Merchandising</Link>
      <h1 className="display-type">{product.name}</h1>
      <p>{title} · Version {view.revision}{view.baseline ? " · Proposed catalog revision" : ""}</p>
    </div>
    <div className="merch-stack">
      <div className="merch-columns">
        <section className="commerce-panel merch-sources">
          <h2>Source and confirmed facts</h2>
          <dl className="merch-facts">
            <div><dt>Supplier or source</dt><dd>{view.source.supplier}</dd></div>
            <div><dt>Product reference</dt><dd>{view.source.externalId}</dd></div>
            <div><dt>Source file</dt><dd>{view.source.file}{view.source.rows.length > 0 && ` · rows ${view.source.rows.join(", ")}`}</dd></div>
            <div><dt>Received</dt><dd><time dateTime={view.source.importedAt}>{new Date(view.source.importedAt).toLocaleString("en-BD", { timeZone: "Asia/Dhaka" })}</time></dd></div>
            <div><dt>Source version</dt><dd><code>{view.sourceVersion.slice(0, 12)}</code></dd></div>
            {view.source.evidence.sourceRecord && <div><dt>Source record</dt><dd>{view.source.evidence.sourceRecord}</dd></div>}
          </dl>
          {view.source.evidence.sourceUrl && <a className="text-link" href={view.source.evidence.sourceUrl} rel="noreferrer">Open supplied source URL</a>}
          <p className="merch-copy">{view.source.product.description || "The source supplied no description."}</p>
          {view.source.evidence.supplierAvailability && <p>Supplier availability · {view.source.evidence.supplierAvailability}</p>}
          <ul className="merch-notes">{reviewedFacts(view).map((fact) => <li key={fact.label}><strong>{fact.label}</strong> · {fact.value}
            <p className="merch-provenance">{fact.status === "verified" ? "Business verified" : fact.status === "supplier" ? "Source statement" : "Needs evidence"}{fact.evidence && " · " + fact.evidence}</p>
          </li>)}</ul>
          {view.source.duplicateRows.length > 0 && <p>Repeated rows {view.source.duplicateRows.join(", ")}</p>}
        </section>
        <section className="commerce-panel">
          <h2>Proposed listing</h2>
          <dl className="merch-facts">
            <div><dt>Product ID</dt><dd>{product.id}</dd></div>
            <div><dt>Store category</dt><dd>{choices.departments.find(({ id }) => product.departmentId === id)?.name ?? product.departmentId}</dd></div>
            <div><dt>Language</dt><dd>English</dd></div>
            <div><dt>Wording</dt><dd>{view.draft.wording === "model-assisted" ? "Model assisted" : view.draft.wording === "staff" ? "Staff edited" : "Supplied content"}</dd></div>
          </dl>
          <p><strong>{product.shortDescription ?? product.name}</strong></p>
          <p className="merch-copy">{product.description || "Description needed"}</p>
          {product.collectionIds.length > 0 && <p>Collections · {product.collectionIds.map((id) => choices.collections.find((row) => row.id === id)?.name ?? id).join(", ")}</p>}
          <ul className="merch-notes">{product.variants.map((variant) => <li key={variant.sku}>
            <strong>{variant.sku}</strong> · {Object.values(variant.options).join(" / ") || "Standard"}
            {evidence.supplierSkus[variant.sku] && <p className="merch-provenance">Supplier SKU · {evidence.supplierSkus[variant.sku]}</p>}
          </li>)}</ul>
          <Link className="button button--outline" href={href + "?view=edit"}>Edit proposed listing</Link>
        </section>
      </div>
      <section className="commerce-panel">
        <h2>Market and catalog checks</h2>
        {status.global.length > 0 && <ul className="merch-notes">{status.global.map((gap, index) => <li key={index}>{gap}</li>)}</ul>}
        {view.source.conflicts.length > 0 && <details open={!view.draft.resolution}>
          <summary>{view.source.conflicts.length} conflicting source field(s)</summary>
          <ul className="merch-notes">{view.source.conflicts.slice(0, 150).map((item, index) => <li key={index}>
            Row {item.row} · {item.field} · <q>{item.earlier}</q> / <q>{item.incoming}</q></li>)}</ul>
          {view.draft.resolution && <p>Recorded decision · {view.draft.resolution}</p>}
        </details>}
        <div className="merch-columns">
          {status.markets.map((item) => <div key={item.market}>
            <h3>{markets[item.market].name} · {item.ready ? "Ready" : "Unavailable"}</h3>
            {item.marketGaps.length > 0 && <ul className="merch-notes">{item.marketGaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>}
            <Link className="text-link" href={href + "?market=" + item.market + "#product-preview"}>Preview {markets[item.market].name}</Link>
          </div>)}
        </div>
        <details>
          <summary>Image approvals and usage</summary>
          {evidence.images.length === 0 ? <p>No image approval is attached.</p> : <ul className="merch-notes">{evidence.images.map((photo) =>
            <li key={photo.src}><code>{photo.src}</code> · {photo.evidence} · {photo.usage}</li>)}</ul>}
        </details>
        {view.baseline && <details><summary>Differences from the recorded catalog version</summary>
          {liveDiff.length ? <ul className="merch-notes">{liveDiff.map(([key, value]) => <li key={key}><strong>{key}</strong>
            <div className="merch-columns"><pre className="merch-compare">{JSON.stringify(view.baseline?.[key as keyof typeof product], null, 2)}</pre>
              <pre className="merch-compare">{JSON.stringify(value, null, 2)}</pre></div></li>)}</ul> : <p>There are no listing changes in this proposed version.</p>}
        </details>}
      </section>
      {query.view === "edit" && <section id="edit" aria-label="Edit candidate">
        <ProductEditor key={view.revision} existing={{ product, revision: view.revision }} departments={choices.departments}
          collections={choices.collections} production={false}
          reviewDraft={{ id, completeHref: href }} />
      </section>}
      <section className="commerce-panel">
        <details>
          <summary>Edit source evidence and conflict decisions</summary>
          <MerchandisingForm operation="evidence" hidden={identity} label="Save evidence">
            <label>Evidence record<textarea name="evidence" rows={12} defaultValue={JSON.stringify(evidence, null, 2)} maxLength={60_000} required /></label>
            <label>Conflict resolution<textarea name="resolution" rows={3} defaultValue={view.draft.resolution} maxLength={1000} /></label>
          </MerchandisingForm>
        </details>
      </section>
      <section className="commerce-panel">
        <h2>Pricing worksheets · {market.name}</h2>
        {pricing(view, market.id).map((sheet) => <details className="merch-worksheet" key={sheet.sku}>
          <summary>{sheet.sku} · {sheet.contribution === null ? "Incomplete" : "Contribution estimate available"}</summary>
          <dl className="merch-facts">
            <div><dt>Proposed unit price</dt><dd>{monetary(sheet.selling, market.id)}</dd></div>
            <div><dt>Units per scenario</dt><dd>{sheet.units ?? "Unavailable"}</dd></div>
            <div><dt>Order revenue</dt><dd>{monetary(sheet.revenue, market.id)}</dd></div>
            <div><dt>Supplied unit cost</dt><dd>{sheet.product ? `${(sheet.product.minor / 100).toFixed(2)} ${sheet.product.currency} · ${sheet.product.evidence}` : "Unavailable"}</dd></div>
            <div><dt>Order product cost</dt><dd>{monetary(sheet.convertedCost, market.id)}</dd></div>
            {sheet.conversion && <div><dt>Exchange rate</dt><dd>{sheet.conversion.rate} {sheet.conversion.to}/{sheet.conversion.from} · {sheet.conversion.observedOn} · {sheet.conversion.evidence}</dd></div>}
            {sheet.direct.map((cost) => <div key={cost.type}><dt>{cost.type}</dt><dd>{monetary(cost.minor, market.id)}{cost.evidence && " · " + cost.evidence}</dd></div>)}
            <div><dt>Estimated contribution before ads and overhead</dt><dd>{monetary(sheet.contribution, market.id)}</dd></div>
          </dl>
          {sheet.unknown.length > 0 && <p>Required inputs · {sheet.unknown.join(" · ")}</p>}
        </details>)}
      </section>
      <section className="commerce-panel">
        <h2>Review and catalog actions</h2>
        {view.approval && <p>Approved version {view.approval.revision} · {view.approval.markets.map((id) => markets[id].name).join(", ")}</p>}
        <div className="merch-actions">
          {status.ready && !approved && view.decision !== "rejected" && <MerchandisingForm operation="decision" label="Approve this version" hidden={{ ...identity, action: "approve", scope }} primary />}
          {approved && !view.publishedAt && <>
            {privateDraft && view.stagedRevision !== view.revision && <MerchandisingForm operation="decision" label="Save in catalog as draft" hidden={{ ...identity, action: "transfer" }} primary />}
            {(!privateDraft || view.stagedRevision === view.revision) && <MerchandisingForm operation="decision" label="Publish reviewed version to staging" hidden={{ ...identity, action: "publish" }} primary />}
          </>}
          {status.catalogChanged && <MerchandisingForm operation="decision" label="Refresh catalog baseline" hidden={{ ...identity, action: "refresh" }} />}
        </div>
        {view.decision !== "rejected" && !view.publishedAt && <details><summary>Reject candidate</summary>
          <MerchandisingForm operation="decision" label="Reject" hidden={{ ...identity, action: "reject" }}>
            <label>Reason<input name="reason" required maxLength={600} /></label>
          </MerchandisingForm>
        </details>}
        {status.current && <p><Link className="text-link" href={`/staff/catalog/products/${product.id}`}>Open catalog record</Link>
          {view.publishedAt && <> · <Link className="text-link" href={`/products/${product.slug}`}>Open staging listing</Link></>}</p>}
        <details><summary>Audit history</summary><ul className="merch-notes">
          {history.map((row, index) => <li key={index}>{typeof row.changes === "object" && row.changes && "step" in row.changes ? String(row.changes.step) : "Recorded change"}
            {" · "}<time dateTime={row.createdAt.toISOString()}>{row.createdAt.toISOString().slice(0, 16).replace("T", " ")}</time> UTC</li>)}
        </ul></details>
      </section>
      <section className="commerce-panel">
        <h2>Merchandising worker</h2>
        <p>Selected market · {market.name}</p>
        {query.task && <p role="status">Worker status · {task ? task.reason === "provider-unconfigured" ? "Model generation unavailable" :
          [task.state, task.reason].filter(Boolean).join(" · ") : "Runner unavailable"}</p>}
        {lastRun && <p>{lastRun.focus.length} selected fact references{lastRun.category ? " · Suggested category " + lastRun.category : ""}.</p>}
        <div className="merch-actions">
          <MerchandisingForm operation="decision" label="Request listing suggestions" hidden={{ ...identity, action: "queue-listing", market: market.id }} />
          {approved && view.approval?.markets.includes(market.id) && <MerchandisingForm operation="decision" label="Request AI launch copy" hidden={{ ...identity, action: "queue-launch", market: market.id }} />}
          {lastRun && query.task && <MerchandisingForm operation="decision" label="Save worker proposal" hidden={{ ...identity, action: `apply-${direction}`, task: query.task, market: market.id }} />}
          {query.task && <Link className="button button--outline" href={href + `?market=${market.id}&intent=${direction}&task=${query.task}`} prefetch={false}>Check worker status</Link>}
        </div>
      </section>
      <section className="commerce-panel" id="product-preview">
        <h2>Storefront preview · {market.name}</h2>
        {catalog ? <>
          <div className="merch-preview-card"><ProductGrid cards={productCards([catalog])} market={market} preview /></div>
          <ProductDetail product={catalog} market={market} departmentName={choices.departments.find((choice) => choice.id === product.departmentId)?.name ?? "Catalog"} preview />
        </> : <p>Add approved images and at least one variant to preview the listing.</p>}
      </section>
      <section className="commerce-panel">
        <h2>Launch content drafts</h2>
        {approved && view.approval?.markets.includes(market.id) && <MerchandisingForm operation="decision" label="Prepare launch draft from reviewed facts"
          hidden={{ ...identity, action: "staff-launch", market: market.id }} />}
        {launches.map((item) => <details key={item.market} open>
          <summary>{markets[item.market].name} · Version {item.revision} · {item.stale ? "Refresh required" : item.method === "staff" ? "Template draft" : "Model assisted draft"}</summary>
          <p>{item.text.brief}</p>
          <h3>Headlines</h3><ul className="merch-notes">{item.text.headlines.map((line) => <li key={line}>{line}</li>)}</ul>
          <h3>Captions</h3><ul className="merch-notes">{item.text.captions.map((line) => <li key={line}>{line}</li>)}</ul>
          <h3>15-second demonstration</h3><ol className="merch-notes">{item.text.script.map((line) => <li key={line}>{line}</li>)}</ol>
          <p>Approved assets · {item.text.images.join(", ")}</p>
          <p>{item.text.destination && !item.stale ? <Link className="text-link" href={item.text.destination}>{item.text.cta}</Link> : item.text.cta}</p>
        </details>)}
      </section>
    </div>
  </>;
}

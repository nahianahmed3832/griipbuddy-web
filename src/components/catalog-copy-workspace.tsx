import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { generateCatalogCopy } from "@/app/staff/catalog-copy-actions";
import { catalogCopyFixture, catalogCopyHistory, type CopyActor } from "@/lib/intelligence/catalog-copy-suggestions";
import { marketConfiguration } from "@/lib/market-config";
import type { MarketId } from "@/config/markets";
import { StaffActionForm } from "./staff-actions";
import styles from "./catalog-copy-workspace.module.css";

export async function CatalogCopyWorkspace({ actor, marketId, product, back }: {
  actor: CopyActor; marketId: MarketId; product?: string; back: string;
}) {
  const history = await catalogCopyHistory(actor, marketId);
  if (!history) notFound();
  const market = marketConfiguration(marketId);
  const fixture = catalogCopyFixture();
  return <div className={styles.workspace}>
    <div className="commerce-intro">
      <Link href={back} className="text-link">{actor.kind === "staff" ? "Product intelligence" : "Seller listings"}</Link>
      <h1>Catalog copy assistant</h1>
      <p>{market.name} · {fixture ? "Simulated provider" : "Provider unavailable"}</p>
    </div>
    <div className="commerce-layout">
      <section className="commerce-panel">
        <h2>Generate a suggestion</h2>
        <p>Review generated text before taking it to the existing catalog editor.</p>
        {fixture ? <StaffActionForm action={generateCatalogCopy.bind(null, actor.kind, marketId, actor.kind === "seller" ? actor.shopId : null)}
          submitLabel="Generate review copy">
          <input type="hidden" name="operationId" value={randomUUID()}/>
          <label>Catalog product ID<input name="productId" defaultValue={product} maxLength={120} required /></label>
          <label>Copy field<select name="purpose"><option value="summary">Short description</option><option value="description">Description</option></select></label>
        </StaffActionForm> : <p className="commerce-message">An authorized development fixture is required to generate suggestions here.</p>}
      </section>
      <section className="commerce-panel">
        <h2>Your review history</h2>
        {history.length ? <ul className={styles.history}>{history.map(item => <li key={item.operationId}>
          <p><strong>{item.productId}</strong> · {item.purpose === "summary" ? "Short description" : "Description"}</p>
          <p>{item.body ?? "Unavailable · No validated copy"}</p>
          <small>Source revision {item.productRevision} · <time dateTime={item.createdAt.toISOString()}>
            {new Intl.DateTimeFormat(market.locale, {dateStyle:"medium",timeZone:market.timeZone}).format(item.createdAt)}
          </time></small>
        </li>)}</ul> : <p>No suggestions have been saved for you in this market.</p>}
      </section>
    </div>
  </div>;
}

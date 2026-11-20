import Link from "next/link";
import { ObserveIntelligenceDraft } from "@/components/intelligence-draft-forms";
import type { MarketId } from "@/config/markets";
import { draftDay, draftEvidenceInput, draftOutcomes, draftTypes, listIntelligenceDrafts } from "@/lib/intelligence/drafts";
import { intelligenceUrl } from "@/lib/intelligence/navigation";
import { shiftCalendarDay } from "@/lib/market-calendar";
import { workflowUrl } from "@/lib/workflows/navigation";
import type { DraftPermission } from "./intelligence-overview";
import { TextList } from "./intelligence-ui";

export async function IntelligenceDrafts({ marketId, test, permission }: { marketId: MarketId; test: boolean; permission: DraftPermission }) {
  const rows = await listIntelligenceDrafts(permission.actorId, marketId, test);
  return <section className="commerce-panel intel-panel">
    <h2>Recommendation history and observed outcomes</h2>
    <p>Drafts save an evidence snapshot for review. A draft collection keeps a proposed product and rationale. Product tests and purchases follow their separate operating workflows.</p>
    {!rows.length && <p>No drafts in the selected market and dataset.</p>}
    {rows.length > 0 && <div className="intel-grid">{rows.map(row => {
      const decoded = draftEvidenceInput.safeParse(row.evidence);
      const evidence = decoded.success ? decoded.data : null;
      const canObserve = row.kind === "PURCHASING" ? permission.operations : permission.merchandising;
      return <article className="intel-card" key={row.id}>
        <h3>{evidence?.title ?? "Saved intelligence draft"}</h3>
        <p className="intel-meta">{draftTypes[row.kind]} · {draftDay(row.from)} – {draftDay(row.through)}{test && " · Fixture evidence"}</p>
        {evidence && <><TextList entries={evidence.facts}/><p><strong>Hypothesis</strong> {evidence.hypothesis}</p>
          {evidence.quantity !== undefined && <p>Proposed quantity {evidence.quantity} units</p>}
          <Link href={evidence.href}>Open original evidence</Link>
          {canObserve && <Link href={workflowUrl({ market: marketId, scope: test ? "test" : "live", draft: row.id }, "new")}>
            Start workflow from this insight</Link>}</>}
        {row.observations.length ? <div>
          <h4>Staff-reported observations</h4>
          <ul>{row.observations.map(observation => <li key={observation.id}>
            <strong>{draftOutcomes[observation.result]}</strong> · {draftDay(observation.from)} – {draftDay(observation.through)}
            <p>{observation.note}</p>
            <Link href={intelligenceUrl({ market: marketId, scope: test ? "test" : "live", from: draftDay(observation.from),
              to: draftDay(observation.through), product: evidence?.productId, variant: evidence?.variantId })}>Open observation period</Link>
          </li>)}</ul>
        </div> : <p className="intel-muted">Pending follow-up evidence.</p>}
        {canObserve && <ObserveIntelligenceDraft id={row.id} firstDay={shiftCalendarDay(draftDay(row.through), 1) ?? undefined} />}
      </article>;
    })}</div>}
  </section>;
}

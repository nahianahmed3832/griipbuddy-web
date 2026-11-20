"use client";

import { useActionState, useId } from "react";
import { createIntelligenceDraftAction, observeIntelligenceDraftAction } from "@/app/staff/intelligence-actions";

export function CreateIntelligenceDraft({ evidence, options }: { evidence: string; options: { value: string; label: string }[] }) {
  const [state, action, pending] = useActionState(createIntelligenceDraftAction, {});
  const select = useId();
  if (!options.length) return null;
  return <form action={action} className="commerce-form intel-draft-form">
    <input type="hidden" name="evidence" value={evidence} />
    <label htmlFor={select}>Draft type<select id={select} name="kind">{options.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select></label>
    <button type="submit" className="button button--outline" disabled={pending}>{pending ? "Saving draft…" : "Create draft"}</button>
    {state.message && <p role="status">{state.message}</p>}
  </form>;
}

export function ObserveIntelligenceDraft({ id, firstDay }: { id: string; firstDay?: string }) {
  const [state, action, pending] = useActionState(observeIntelligenceDraftAction, {});
  return <details><summary>Record a follow-up observation</summary>
    <form action={action} className="commerce-form intel-observation">
      <input type="hidden" name="id" value={id} />
      <div className="commerce-fields">
        <label>Observed from<input name="from" type="date" min={firstDay} required /></label>
        <label>Observed through<input name="to" type="date" min={firstDay} required /></label>
        <label>Outcome<select name="result" defaultValue="INCONCLUSIVE">
          <option value="INCONCLUSIVE">Inconclusive</option><option value="POSITIVE">Positive signal</option><option value="NEGATIVE">Negative signal</option>
        </select></label>
      </div>
      <label>Aggregate evidence note<textarea name="note" maxLength={500} rows={3} required /></label>
      <button type="submit" className="button button--outline" disabled={pending}>{pending ? "Saving observation…" : "Save observation"}</button>
      {state.message && <p role="status">{state.message}</p>}
    </form>
  </details>;
}

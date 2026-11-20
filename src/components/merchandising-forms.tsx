"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, type ReactNode } from "react";
import { postMerchandising } from "@/lib/staff/merchandising-client";
import type { Feedback as MerchandisingFeedback } from "@/lib/staff/merchandising-http";

type State = MerchandisingFeedback;
const path = "/staff/catalog/merchandising";

function Feedback({ state }: { state: State }) {
  return <>
    {state.error && <p role="alert" className="commerce-message commerce-message--error">{state.error}</p>}
    {state.success && <p role="status" className="commerce-message">{state.success}</p>}
    {state.receipt && <ul aria-label="Batch results" className="merch-notes">{state.receipt.map(({ id, message, ok }) =>
      <li key={id}>{id.length === 64 ? <Link className="text-link" href={path + "/" + id}>{message}</Link> : message}
        {!ok && <span className="merch-flag">Needs attention</span>}</li>)}</ul>}
  </>;
}

export function MerchandisingForm({ operation, children, label, hidden, primary }: {
  operation: string; children?: ReactNode; label: string; hidden?: Record<string, string>; primary?: boolean;
}) {
  const router = useRouter();
  const [state, write, pending] = useActionState(async (_previous: State, form: FormData) => {
    form.set("operation", operation);
    const result = await postMerchandising(form);
    if (!result.error) {
      if (result.href) router.push(result.href);
      router.refresh();
    }
    return result;
  }, {});
  return <form action={write} className="commerce-form merch-form">
    {Object.entries(hidden ?? {}).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
    {children}
    <button type="submit" disabled={pending} className={`button ${primary ? "button--primary" : "button--outline"}`}>
      {pending ? "Saving…" : label}
    </button>
    <Feedback state={state} />
  </form>;
}

export function SourceForms() {
  return <div className="merch-columns">
    <section className="commerce-panel">
      <h2>Import product sources</h2>
      <MerchandisingForm operation="intake" label="Create candidates" primary>
        <label>Supplier or source reference<input name="supplier" required maxLength={120} /></label>
        <label>Catalog CSV<input type="file" name="catalog" accept=".csv,text/csv" required /></label>
        <label>Evidence manifest<input type="file" name="evidence" accept=".json,application/json" /></label>
      </MerchandisingForm>
    </section>
    <section className="commerce-panel">
      <h2>Propose changes to a product</h2>
      <MerchandisingForm operation="existing" label="Open proposal">
        <label>Existing catalog product ID<input name="product" required maxLength={80} /></label>
      </MerchandisingForm>
    </section>
  </div>;
}

export function BatchForm({ children }: { children: ReactNode }) {
  return <MerchandisingForm operation="batch" label="Approve selected versions">{children}</MerchandisingForm>;
}

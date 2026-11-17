"use client";

import { Printer } from "lucide-react";
import { useActionState, type ReactNode } from "react";

type ActionState = { error?: string; success?: string };

export function StaffActionForm({ action, submitLabel, children, secondary = false }: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  submitLabel: string;
  children?: ReactNode;
  secondary?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <form action={formAction} className="commerce-form staff-action-form">
      {children}
      <button className={`button ${secondary ? "button--outline" : "button--primary"}`} type="submit" disabled={pending}>
        {pending ? "Saving…" : submitLabel}
      </button>
      {state.error && <p role="alert" className="commerce-message commerce-message--error">{state.error}</p>}
      {state.success && <p role="status" className="commerce-message">{state.success}</p>}
    </form>
  );
}

export function PrintPackingSlip() {
  return <button className="button button--outline" type="button" onClick={() => window.print()}><Printer size={17} aria-hidden="true" /> Print packing slip</button>;
}

"use client";

import { useActionState, type ReactNode } from "react";
import { createWorkflowAction, workflowCommandAction } from "@/app/staff/workflow-actions";

export function WorkflowIntakeForm({ children }: { children: ReactNode }) {
  const [state, formAction, pending] = useActionState(createWorkflowAction, {});
  return <form action={formAction} className="commerce-form">
    {children}
    <button className="button button--primary" type="submit" disabled={pending}>{pending ? "Saving workflow…" : "Create workflow draft"}</button>
    {state.message && <p role="status">{state.message}</p>}
  </form>;
}

export function WorkflowCommand({ id, commands }: { id: string; commands: readonly { value: string; label: string }[] }) {
  const [state, formAction, pending] = useActionState(workflowCommandAction, {});
  if (!commands.length) return null;
  return <form action={formAction} className="commerce-form">
    <input name="id" type="hidden" value={id} />
    <div className="workflow-tools">{commands.map(({ value, label }, i) => <button key={value} className={`button button--${i === 0 ? "primary" : "outline"}`}
      name="command" value={value} type="submit" disabled={pending}>{label}</button>)}</div>
    {state.message && <p role="status">{state.message}</p>}
  </form>;
}

export function WorkflowCorrection({ id }: { id: string }) {
  const [state, formAction, pending] = useActionState(workflowCommandAction, {});
  return <form action={formAction} className="commerce-form">
    <input type="hidden" name="id" value={id} /><input type="hidden" name="command" value="record-correction" />
    <label>Completed homepage workflow ID<input name="appliedWorkflow" maxLength={36} required /></label>
    <button className="button button--outline" disabled={pending}>Link applied correction</button>
    {state.message && <p role="status">{state.message}</p>}
  </form>;
}

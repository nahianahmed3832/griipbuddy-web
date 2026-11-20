"use client";

import { useActionState, useSyncExternalStore, type ReactNode } from "react";
import styles from "./seller-finance.module.css";

type State = { error?: string; success?: string };
const subscribe = () => () => {};
const ready = () => true;
const serverReady = () => false;

export type FinanceFormAction = (state: State, data: FormData) => Promise<State>;

export function FinanceForm({ action, children, submit, operationId }: {
  action: FinanceFormAction; children: ReactNode; submit: string; operationId?: string;
}) {
  const [state, dispatch, pending] = useActionState(action, {});
  const hydrated = useSyncExternalStore(subscribe, ready, serverReady);
  return <form action={dispatch} className={styles.actionForm} aria-busy={pending}>
    {operationId && <input type="hidden" name="operationId" value={operationId} />}
    <fieldset disabled={pending || !hydrated}>
      {children}
      <button type="submit" className={styles.primary}>{pending ? "Saving…" : submit}</button>
    </fieldset>
    {state.error && <p className={styles.error} role="alert">{state.error}</p>}
    {state.success && <p className={styles.success} role="status">{state.success}</p>}
  </form>;
}

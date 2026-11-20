"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { storefrontPath } from "@/config/storefront-path";

const subscribeToHydration = () => () => {};

export function WorkspaceCommandForm({ endpoint, action, operationKey = "key", values, submit, children }: {
  endpoint: string;
  action: string;
  operationKey?: "key" | "operationId";
  values?: Record<string, string | number>;
  submit: string;
  children?: ReactNode;
}) {
  const router = useRouter();
  const ready = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  const operation = useRef<{ fingerprint: string; id: string } | undefined>(undefined);
  const sending = useRef(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean }>();

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    const form = new FormData(event.currentTarget);
    const input: Record<string, unknown> = { action, ...values };
    const answers: Record<string, string> = {};
    for (const [name, raw] of form) {
      if (typeof raw !== "string") continue;
      if (name.startsWith("answers.")) answers[name.slice(8)] = raw;
      else if (name !== "fields" && raw !== "") input[name] = raw;
      else if (["about", "announcement", "postal"].includes(name)) input[name] = raw;
    }
    if (Object.keys(answers).length) input.answers = answers;
    if (action === "verification.form") input.fields = form.getAll("fields");
    const fingerprint = JSON.stringify(input);
    if (operation.current?.fingerprint !== fingerprint) operation.current = { fingerprint, id: crypto.randomUUID() };
    sending.current = true;
    setPending(true);
    setStatus(undefined);
    try {
      const response = await fetch(storefrontPath(endpoint), { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, [operationKey]: operation.current.id }) });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setStatus({ error: true, text: data?.message ?? "The operation could not be confirmed." });
        return;
      }
      operation.current = undefined;
      setStatus({ error: false, text: "Saved." });
      router.refresh();
    } catch {
      setStatus({ error: true, text: "The connection was interrupted. Submit the same details to check the operation." });
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  return <form className="workspace-command" onSubmit={save}>
    <fieldset disabled={pending || !ready}>
      {children}
      <button type="submit" className="button button--outline">{pending ? "Saving…" : submit}</button>
    </fieldset>
    {status && <p role={status.error ? "alert" : "status"}>{status.text}</p>}
  </form>;
}

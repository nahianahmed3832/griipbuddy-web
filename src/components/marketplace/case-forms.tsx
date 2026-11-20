"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type FormEvent } from "react";
import { z } from "zod";
import { storefrontPath } from "@/config/storefront-path";
import type { OrderCaseKind, OrderCaseStatus } from "@/generated/prisma/enums";
import { caseCommand, mayWithdrawCase, type CaseCommand } from "@/lib/marketplace/case-policy";
import { purchasedOptions } from "@/lib/commerce/purchased-options";
import type { ExchangeVariant } from "@/lib/marketplace/case-shopper";
import { MarketplaceForm } from "./action-form";

const endpoint = "/api/marketplace/cases";
const requestLabels: Record<OrderCaseKind, string> = {
  CANCEL: "Cancel order",
  RETURN: "Return items",
  EXCHANGE: "Exchange a size or color",
  DISPUTE: "Report a problem",
};

export type CaseRequestItem = {
  id: string;
  productName: string;
  variantName: string;
  sku?: string;
  optionsSnapshot?: unknown;
  personalization: string;
  quantity: number;
  replacements?: readonly ExchangeVariant[];
};

function CaseItemFields({ item, exchange }: { item: CaseRequestItem; exchange: boolean }) {
  const [replacementId, setReplacementId] = useState("");
  const replacement = item.replacements?.find(variant => variant.id === replacementId);
  const maximum = replacement ? Math.min(item.quantity, replacement.available) : item.quantity;
  const itemName = [item.productName, purchasedOptions(item), item.sku, item.personalization].filter(Boolean).join(" · ");
  return (
    <fieldset className="case-item-fields">
      <legend>{item.productName}</legend>
      <p>{[purchasedOptions(item), item.sku].filter(Boolean).join(" · ")}</p>
      {item.personalization && <p>Personalization: {item.personalization}</p>}
      {exchange && (
        <label>
          Replacement size or color
          <select name={`replacement-${item.id}`} value={replacementId} onChange={event => setReplacementId(event.target.value)}>
            <option value="">Choose a size or color</option>
            {item.replacements?.map(variant => <option key={variant.id} value={variant.id}>{variant.label} · {variant.sku}</option>)}
          </select>
        </label>
      )}
      <label>
        Quantity {exchange ? "to exchange" : "to return"} (up to {maximum})
        <input type="number" aria-label={`Quantity to ${exchange ? "exchange" : "return"} for ${itemName}`}
          name={`quantity-${item.id}`} min={0} max={maximum} step={1} defaultValue={0} disabled={exchange && !replacement} />
      </label>
    </fieldset>
  );
}

type OpenCommand = Extract<CaseCommand, { action: "open" }>;
type CaseReceipt = { id: string; kind: OrderCaseKind };
const openResult = z.object({ data: z.object({ id: z.uuid() }) });
const rejection = z.object({ message: z.string().min(1) });

async function submitCase(command: OpenCommand) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(storefrontPath(endpoint), {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
      redirect: "error", signal: controller.signal, body: JSON.stringify(command),
    });
    const result: unknown = await response.json().catch(() => null);
    if (response.status === 201) {
      const saved = openResult.safeParse(result);
      if (saved.success) return { status: "created" as const, id: saved.data.data.id };
    }
    const rejected = rejection.safeParse(result);
    if (response.status >= 400 && response.status < 500 && rejected.success) {
      return { status: "rejected" as const, message: rejected.data.message, conflict: response.status === 409 };
    }
    throw new Error("Unconfirmed case submission");
  } finally {
    clearTimeout(timeout);
  }
}

type OpenState =
  | { status: "ready" | "submitting" }
  | { status: "rejected"; message: string; conflict?: boolean }
  | { status: "unknown"; kind: OrderCaseKind; previousIds: string[]; checked: boolean }
  | { status: "submitted"; caseId: string };

export function RefreshOrderRequests({ label = "Refresh request status" }: { label?: string }) {
  const router = useRouter();
  const [checking, startRefresh] = useTransition();
  return <button className="button button--outline" type="button" disabled={checking}
    onClick={() => startRefresh(() => router.refresh())}>
    {checking ? "Checking requests…" : label}
  </button>;
}

export function OpenOrderCase({ orderId, available, returnItems, cases }: {
  orderId: string;
  available: readonly OrderCaseKind[];
  returnItems?: readonly CaseRequestItem[];
  cases: readonly CaseReceipt[];
}) {
  const router = useRouter();
  const inFlight = useRef(false);
  const [state, setState] = useState<OpenState>({ status: "ready" });
  const [checking, startRefresh] = useTransition();
  const [choice, setChoice] = useState(available[0]);
  const kind = available.includes(choice) ? choice : undefined;
  const exchange = kind === "EXCHANGE";
  const items = exchange ? returnItems?.filter(item => item.replacements?.length) : kind === "RETURN" ? returnItems : undefined;
  const latest = state.status === "unknown" && state.checked && !checking
    ? cases.find(row => row.kind === state.kind && !state.previousIds.includes(row.id)) : undefined;
  const href = (id: string) => `/orders/${orderId}/cases/${id}`;
  const pending = state.status === "submitting";
  const locked = pending || checking || state.status === "submitted" || state.status === "unknown";

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!kind || locked || inFlight.current) return;
    const form = new FormData(event.currentTarget);
    const lines = items?.flatMap(item => {
      const quantity = Number(form.get(`quantity-${item.id}`));
      if (!Number.isInteger(quantity) || quantity < 1) return [];
      return [{ orderItemId: item.id, quantity,
        ...(exchange && { replacementVariantId: form.get(`replacement-${item.id}`) }) }];
    });
    if (lines?.length === 0) {
      setState({ status: "rejected", message: exchange
        ? "Choose a replacement and quantity for at least one item."
        : "Enter the quantity for at least one item to return." });
      return;
    }
    const command = caseCommand.safeParse({ action: "open", orderId, kind, note: form.get("note"), ...(lines && { lines }) });
    if (!command.success || command.data.action !== "open") {
      setState({ status: "rejected", message: "Review the selected items and enter a reason between 10 and 1,500 characters." });
      return;
    }
    inFlight.current = true;
    setState({ status: "submitting" });
    try {
      const outcome = await submitCase(command.data);
      if (outcome.status === "created") {
        setState({ status: "submitted", caseId: outcome.id });
        router.push(href(outcome.id));
      } else {
        setState({ status: "rejected", message: outcome.message, conflict: outcome.conflict });
      }
    } catch {
      setState({ status: "unknown", kind, previousIds: cases.map(row => row.id), checked: false });
    } finally {
      inFlight.current = false;
    }
  }

  function checkOrderRequests() {
    if (state.status === "unknown") setState({ ...state, checked: true });
    startRefresh(() => router.refresh());
  }

  return (
    <details className="case-request">
      <summary>Start a request</summary>
      <form className="mp-form case-submit" method="post" onSubmit={save} aria-busy={pending || checking}>
        <fieldset className="case-submit-fields" disabled={locked}>
          <label>
            Request type
            <select name="kind" value={choice} onChange={event => setChoice(event.target.value as OrderCaseKind)} required>
              {!kind && <option value={choice} disabled>{requestLabels[choice]} · Unavailable</option>}
              {available.map(kind => <option key={kind} value={kind}>{requestLabels[kind]}</option>)}
            </select>
          </label>
          {items && <fieldset className="case-request-items">
            <legend>{exchange ? "Items to exchange" : "Items to return"}</legend>
            <p>{exchange
              ? "Choose a replacement and the quantity to exchange. Staff will confirm availability before sending it."
              : "Enter a quantity for each item you want to return."}</p>
            {items.map(item => <CaseItemFields key={`${kind}-${item.id}`} item={item} exchange={exchange} />)}
          </fieldset>}
          {kind === "CANCEL" && <label className="mp-remember">
            <input name="confirm-cancellation" type="checkbox" value="yes" required />
            Request cancellation of the entire order
          </label>}
          <label>{kind === "DISPUTE" ? "What happened?" : "Reason for your request"}
            <textarea name="note" required minLength={10} maxLength={1500} rows={4} data-clarity-mask="true" />
          </label>
        </fieldset>
        {state.status === "rejected" && <p role="alert">{state.message}</p>}
        {state.status === "unknown" && <p role="alert">The request status is unknown. Check your order requests before submitting again.</p>}
        {latest && <p role="status">A new request is visible on this order. <Link className="text-link" href={href(latest.id)} prefetch={false}>Review its details</Link>.</p>}
        {state.status === "submitted" && <p role="status">Your request was submitted. <Link className="text-link" href={href(state.caseId)} prefetch={false}>View request</Link>.</p>}
        {((state.status === "unknown" && !latest) || (state.status === "rejected" && state.conflict)) &&
          <button type="button" className="button button--outline" disabled={checking} onClick={checkOrderRequests}>
            {checking ? "Checking requests…" : "Check order requests"}
          </button>}
        {state.status === "unknown" && state.checked && !checking && !latest && <>
          <p role="status">Review the list of requests for this order. If your request is missing, you can continue editing.</p>
          <button type="button" className="button button--outline" onClick={() => setState({ status: "ready" })}>Continue editing</button>
        </>}
        <button type="submit" className="button button--primary" disabled={!kind || locked}>
          {pending ? "Submitting request…" : "Submit request"}
        </button>
      </form>
    </details>
  );
}

type CaseState = { id: string; revision: number; status: OrderCaseStatus };

export function WithdrawOrderCase({ orderCase }: { orderCase: CaseState }) {
  if (!mayWithdrawCase(orderCase.status)) return null;
  return (
    <details className="case-request">
      <summary>Withdraw this request</summary>
      <MarketplaceForm endpoint={endpoint} label="Confirm withdrawal" success="The request was withdrawn."
        command={() => ({ action: "withdraw", caseId: orderCase.id, revision: orderCase.revision })}
      />
    </details>
  );
}

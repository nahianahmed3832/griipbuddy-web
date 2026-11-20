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

type ItemAction = "cancel" | "return" | "exchange";

function CaseItemFields({ item, action }: { item: CaseRequestItem; action: ItemAction }) {
  const [replacementId, setReplacementId] = useState("");
  const exchange = action === "exchange";
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
        Quantity to {action} (up to {maximum})
        <input type="number" aria-label={`Quantity to ${action} for ${itemName}`}
          name={`quantity-${item.id}`} min={0} max={maximum} step={1} defaultValue={0} disabled={exchange && !replacement} />
      </label>
    </fieldset>
  );
}

type OpenCommand = Extract<CaseCommand, { action: "open" }>;
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
      return { status: "rejected" as const, message: rejected.data.message };
    }
    throw new Error("Unconfirmed case submission");
  } finally {
    clearTimeout(timeout);
  }
}

type OpenState =
  | { status: "ready" | "submitting" }
  | { status: "rejected"; message: string }
  | { status: "unknown"; checked: boolean }
  | { status: "submitted"; caseId: string };

export function RefreshOrderRequests({ label = "Refresh request status" }: { label?: string }) {
  const router = useRouter();
  const [checking, startRefresh] = useTransition();
  return <button className="button button--outline" type="button" disabled={checking}
    onClick={() => startRefresh(() => router.refresh())}>
    {checking ? "Checking requests…" : label}
  </button>;
}

export function OpenOrderCase({ orderId, available, returnItems, cancellationItems }: {
  orderId: string;
  available: readonly OrderCaseKind[];
  returnItems?: readonly CaseRequestItem[];
  cancellationItems?: readonly CaseRequestItem[];
}) {
  const router = useRouter();
  const inFlight = useRef(false);
  const pendingRequest = useRef<{ orderId: string; requestId: string } | null>(null);
  const [state, setState] = useState<OpenState>({ status: "ready" });
  const [checking, setChecking] = useState(false);
  const [receiptMessage, setReceiptMessage] = useState("");
  const [choice, setChoice] = useState<OrderCaseKind | undefined>(available[0]);
  const storageKey = `griipbuddy:order-case-request:${orderId}`;
  const kind = choice && available.includes(choice) ? choice : undefined;
  const exchange = kind === "EXCHANGE";
  const itemAction: ItemAction = kind === "CANCEL" ? "cancel" : exchange ? "exchange" : "return";
  const items = kind === "CANCEL" ? cancellationItems : exchange ? returnItems?.filter(item => item.replacements?.length)
    : kind === "RETURN" ? returnItems : undefined;
  const href = (id: string) => `/orders/${orderId}/cases/${id}`;
  const pending = state.status === "submitting";
  const locked = pending || checking || state.status === "submitted" || state.status === "unknown";

  function currentRequestId() {
    let requestId: string | null = null;
    try { requestId = sessionStorage.getItem(storageKey); } catch { /* In-memory retry still works. */ }
    const parsed = z.uuid().safeParse(requestId);
    return parsed.success ? parsed.data : pendingRequest.current?.orderId === orderId ? pendingRequest.current.requestId : null;
  }

  function recordSubmission(caseId: string) {
    pendingRequest.current = null;
    try { sessionStorage.removeItem(storageKey); } catch { /* The confirmed request is already recorded. */ }
    setState({ status: "submitted", caseId });
  }

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
        : `Enter the quantity for at least one item to ${itemAction}.` });
      return;
    }
    const command = caseCommand.safeParse({ action: "open", orderId, kind, note: form.get("note"), ...(lines && { lines }) });
    if (!command.success || command.data.action !== "open") {
      setState({ status: "rejected", message: "Review the selected items and enter a reason between 10 and 1,500 characters." });
      return;
    }
    const requestId = currentRequestId() ?? crypto.randomUUID();
    pendingRequest.current = { orderId, requestId };
    try { sessionStorage.setItem(storageKey, requestId); } catch { /* In-memory retry still works. */ }
    inFlight.current = true;
    setReceiptMessage("");
    setState({ status: "submitting" });
    try {
      const outcome = await submitCase({ ...command.data, requestId });
      if (outcome.status === "created") {
        recordSubmission(outcome.id);
        router.push(href(outcome.id));
      } else {
        setState({ status: "rejected", message: outcome.message });
      }
    } catch {
      setState({ status: "unknown", checked: false });
    } finally {
      inFlight.current = false;
    }
  }

  async function checkOrderRequests() {
    if (inFlight.current) return;
    const requestId = currentRequestId();
    if (!requestId) {
      setReceiptMessage("There is no unconfirmed submission in this tab.");
      return;
    }
    inFlight.current = true;
    setChecking(true);
    setReceiptMessage("");
    try {
      const query = new URLSearchParams({ orderId, requestId });
      const response = await fetch(`${storefrontPath(endpoint)}?${query}`, {
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404) {
        setReceiptMessage("The submission has not been recorded yet.");
        setState(current => current.status === "unknown" ? { ...current, checked: true } : current);
        return;
      }
      if (!response.ok) throw new Error("Receipt check failed");
      const receipt = openResult.parse(await response.json());
      recordSubmission(receipt.data.id);
      router.refresh();
    } catch {
      setReceiptMessage("The submission could not be checked. Try again shortly.");
    } finally {
      inFlight.current = false;
      setChecking(false);
    }
  }

  return (
    <details className="case-request">
      <summary>{available.length ? "Start a request" : "Check a previous request"}</summary>
      {available.length > 0 && <form className="mp-form case-submit" method="post" onSubmit={save} aria-busy={pending || checking}>
        <fieldset className="case-submit-fields" disabled={locked}>
          <label>
            Request type
            <select name="kind" value={choice ?? ""} onChange={event => setChoice(event.target.value as OrderCaseKind)} required>
              {!kind && <option value={choice ?? ""} disabled>{choice ? `${requestLabels[choice]} · Unavailable` : "Choose a request type"}</option>}
              {available.map(kind => <option key={kind} value={kind}>{requestLabels[kind]}</option>)}
            </select>
          </label>
          {items && <fieldset className="case-request-items">
            <legend>Items to {itemAction}</legend>
            <p>{exchange
              ? "Choose a replacement and the quantity to exchange. Staff will confirm availability before sending it."
              : `Enter a quantity for each item you want to ${itemAction}.`}</p>
            {items.map(item => <CaseItemFields key={`${kind}-${item.id}`} item={item} action={itemAction} />)}
          </fieldset>}
          {kind === "CANCEL" && <label className="mp-remember">
            <input name="confirm-cancellation" type="checkbox" value="yes" required />
            {items ? "Confirm the quantities to cancel" : "Request cancellation of the entire order"}
          </label>}
          <label>{kind === "DISPUTE" ? "What happened?" : "Reason for your request"}
            <textarea name="note" required minLength={10} maxLength={1500} rows={4} data-clarity-mask="true" />
          </label>
        </fieldset>
        {state.status === "rejected" && <p role="alert">{state.message}</p>}
        {state.status === "unknown" && <p role="alert">The request status is unknown. Check your order requests before submitting again.</p>}
        {state.status === "unknown" && state.checked && !checking && <>
          <p role="status">You can continue editing and retry this submission.</p>
          <button type="button" className="button button--outline" onClick={() => setState({ status: "ready" })}>Continue editing</button>
        </>}
        <button type="submit" className="button button--primary" disabled={!kind || locked}>
          {pending ? "Submitting request…" : "Submit request"}
        </button>
      </form>}
      {state.status === "submitted"
        ? <p role="status">Your request was submitted. <Link className="text-link" href={href(state.caseId)} prefetch={false}>View request</Link>.</p>
        : <button type="button" className="button button--outline" disabled={pending || checking} onClick={() => void checkOrderRequests()}>
          {checking ? "Checking requests…" : "Check order requests"}
        </button>}
      {receiptMessage && <p role="status">{receiptMessage}</p>}
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

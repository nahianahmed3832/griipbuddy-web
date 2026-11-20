"use client";

import { useState } from "react";
import type { OrderCaseKind, OrderCaseStatus } from "@/generated/prisma/enums";
import { mayWithdrawCase } from "@/lib/marketplace/case-policy";
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
      <legend>{itemName}</legend>
      {exchange && (
        <label>
          Replacement for {itemName}
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

export function OpenOrderCase({ orderId, available, returnItems }: {
  orderId: string;
  available: readonly OrderCaseKind[];
  returnItems?: readonly CaseRequestItem[];
}) {
  const [choice, setChoice] = useState(available[0]);
  const kind = available.includes(choice) ? choice : available[0];
  const exchange = kind === "EXCHANGE";
  const items = exchange ? returnItems?.filter(item => item.replacements?.length) : kind === "RETURN" ? returnItems : undefined;
  return (
    <details className="case-request">
      <summary>Start a request</summary>
      <MarketplaceForm<{ id: string }> endpoint={endpoint}
        label="Submit request" success="Your request was submitted."
        navigate={({ id }) => `/orders/${orderId}/cases/${id}`}
        fields={<>
          <label>
            Request type
            <select name="kind" value={kind} onChange={event => setChoice(event.target.value as OrderCaseKind)} required>
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
            <textarea name="note" required minLength={10} maxLength={1500} rows={4} />
          </label>
        </>}
        command={form => {
          const lines = items?.flatMap(item => {
            const quantity = Number(form.get(`quantity-${item.id}`));
            if (!Number.isInteger(quantity) || quantity < 1) return [];
            const replacementVariantId = form.get(`replacement-${item.id}`);
            return [{ orderItemId: item.id, quantity, ...(exchange && { replacementVariantId }) }];
          });
          if (lines && lines.length === 0) throw new Error(exchange
            ? "Choose a replacement and quantity for at least one item."
            : "Enter the quantity for at least one item to return.");
          return { action: "open", orderId, kind, note: form.get("note"), ...(lines && { lines }) };
        }}
      />
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

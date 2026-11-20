"use client";

import { useState } from "react";
import type { MarketPaymentMethod } from "@/lib/market-config";

export type ProductDeliveryChoice = { district: string; districtLabel: string; method: string; label: string; paymentMethod: MarketPaymentMethod };
export type ProductDelivery = Pick<ProductDeliveryChoice, "district" | "method" | "paymentMethod"> & { postalCode: string };

export const productPaymentLabels = {
  COD: "Cash on delivery", PAYPAL: "PayPal", SSLCOMMERZ: "Prepaid",
} satisfies Record<MarketPaymentMethod, string>;

function serviceId(choice: ProductDeliveryChoice) {
  return `${choice.paymentMethod}:${choice.method}`;
}

export function ConnectedProductDelivery({ choices, postalRequired, active, onCheck }: {
  choices: readonly ProductDeliveryChoice[]; postalRequired: boolean; active: ProductDelivery | null;
  onCheck: (delivery: ProductDelivery | null) => void;
}) {
  const [district, setDistrict] = useState("");
  const [service, setService] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const districts = new Map<string, string>();
  for (const choice of choices) if (!districts.has(choice.district)) districts.set(choice.district, choice.districtLabel);
  const services = choices.filter(choice => choice.district === district);
  const selected = services.find(choice => serviceId(choice) === service) ?? (services.length === 1 ? services[0] : undefined);
  const validPostal = !postalRequired || /^\d{5}(?:-\d{4})?$/.test(postalCode.trim());
  return <form className="connected-delivery" aria-label="Check delivery" onSubmit={event => {
    event.preventDefault();
    if (!selected || !validPostal) return;
    const { district, method, paymentMethod } = selected;
    onCheck({ district, method, paymentMethod, postalCode: postalRequired ? postalCode.trim() : "" });
  }}>
    <h2>Delivery</h2>
    <div className="connected-delivery__fields">
      <label className="store-dialog__field">{postalRequired ? "State" : "Delivery district"}
        <select required value={district} onChange={event => {
          setDistrict(event.target.value);
          setService("");
          onCheck(null);
        }}>
          <option value="">Choose {postalRequired ? "a state" : "a district"}</option>
          {[...districts].map(([key, label]) => <option value={key} key={key}>{label}</option>)}
        </select>
      </label>
      {postalRequired && <label className="store-dialog__field">ZIP code
        <input required autoComplete="postal-code" inputMode="numeric" maxLength={10} value={postalCode} onChange={event => {
          setPostalCode(event.target.value);
          onCheck(null);
        }} />
      </label>}
      {services.length > 0 && <label className="store-dialog__field">Delivery service
        <select required value={selected ? serviceId(selected) : ""} onChange={event => {
          setService(event.target.value);
          onCheck(null);
        }}>
          {!selected && <option value="">Choose a delivery service</option>}
          {services.map(choice => <option key={serviceId(choice)} value={serviceId(choice)}>
            {choice.label} · {productPaymentLabels[choice.paymentMethod]}
          </option>)}
        </select>
      </label>}
    </div>
    {postalRequired && postalCode && !validPostal && <p className="commerce-muted">Enter a valid ZIP code.</p>}
    <button className="button button--outline" type="submit" disabled={!selected || !validPostal}>
      {active ? "Check delivery again" : "Check delivery"}
    </button>
  </form>;
}

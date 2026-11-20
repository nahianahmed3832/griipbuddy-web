"use client";

import { Minus, Plus } from "lucide-react";

export function QuantityControl({ value, max, onChange, label = "Quantity" }: {
  value: number;
  max: number;
  onChange: (value: number) => void;
  label?: string;
}) {
  return (
    <div className="quantity-control" role="group" aria-label={label}>
      <button type="button" aria-label="Decrease quantity" disabled={value <= 1} onClick={() => onChange(value - 1)}>
        <Minus aria-hidden="true" size={16} strokeWidth={1.8} />
      </button>
      <output aria-label="Current quantity" aria-live="polite">{value}</output>
      <button type="button" aria-label="Increase quantity" disabled={value >= max} onClick={() => onChange(value + 1)}>
        <Plus aria-hidden="true" size={16} strokeWidth={1.8} />
      </button>
    </div>
  );
}

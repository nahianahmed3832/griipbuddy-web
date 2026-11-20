"use client";

import { useId } from "react";
import { MAX_PERSONALIZATION_LENGTH, type Personalization } from "@/lib/catalog/personalization";

export function PersonalizationField({ settings, value, onChange }: {
  settings: Personalization; value: string; onChange: (value: string) => void;
}) {
  const id = useId();
  return <div className="store-dialog__field">
    <label htmlFor={id}>{settings.required ? "Personalization" : "Personalization (optional)"}</label>
    <small id={`${id}-instructions`}>{settings.prompt}</small>
    <input id={id} aria-describedby={`${id}-instructions`} required={settings.required} maxLength={MAX_PERSONALIZATION_LENGTH}
      value={value} onChange={event => onChange(event.target.value)} />
  </div>;
}

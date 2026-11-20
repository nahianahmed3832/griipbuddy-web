"use client";

import { useActionState, useState } from "react";
import { saveRecommendationPolicyAction } from "@/app/staff/homepage-actions";
import {
  recommendationPlacementLabels, recommendationPlacements, recommendationPlacementStrategies, recommendationStrategyLabels,
  type RecommendationPlacement, type RecommendationPolicyOverride, type RecommendationStrategy,
} from "@/lib/catalog/recommendation-policy";

function PolicyToggle({ name, label, value }: { name: string; label: string; value?: boolean }) {
  const [setting, setSetting] = useState(value == null ? "" : value ? "enabled" : "disabled");
  return <label>{label}
    <select name={name} value={setting} onChange={event => setSetting(event.target.value)}>
      <option value="">Inherit</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option>
    </select>
  </label>;
}

function PolicyProducts({ name, label, values }: { name: string; label: string; values?: string[] }) {
  const [override, setOverride] = useState(values !== undefined);
  const [products, setProducts] = useState(values?.join(", ") ?? "");
  return <div className="homepage-editor-wide recommendation-product-field">
    <label><input type="checkbox" name={`${name}-override`} checked={override} onChange={event => setOverride(event.target.checked)} />
      Override inherited {label.toLowerCase()}</label>
    <label>{label}
      <input name={name} value={products} onChange={event => setProducts(event.target.value)} disabled={!override}
        maxLength={2424} placeholder="Product IDs separated by commas" />
    </label>
  </div>;
}

function PolicyStrategy({ placement, value }: { placement: RecommendationPlacement; value?: RecommendationStrategy }) {
  const [strategy, setStrategy] = useState<string>(value ?? "");
  return <label>Strategy
    <select name={`${placement}-strategy`} value={strategy} onChange={event => setStrategy(event.target.value)}>
      <option value="">Inherit</option>
      {recommendationPlacementStrategies[placement].map(key => <option key={key} value={key}>{recommendationStrategyLabels[key]}</option>)}
    </select>
  </label>;
}

export function RecommendationPolicyEditor({ scope, revision, draft }: {
  scope: string; revision: number; draft?: RecommendationPolicyOverride;
}) {
  const [message, action, waiting] = useActionState(saveRecommendationPolicyAction.bind(null, scope, revision), null);
  return <form action={action} className="staff-form homepage-draft-form">
    <PolicyToggle name="behavioral" label="Use consented shopping behavior" value={draft?.behavioralEnabled} />
    {recommendationPlacements.map(placement => {
      const policy = draft?.placements?.[placement];
      return <details key={placement} className="homepage-editor-section">
        <summary>{recommendationPlacementLabels[placement]}</summary>
        <div className="homepage-editor-fields">
          <PolicyToggle name={`${placement}-enabled`} label="Show placement" value={policy?.enabled} />
          <PolicyStrategy placement={placement} value={policy?.strategy} />
          <PolicyProducts name={`${placement}-boosts`} label="Boosted products" values={policy?.boosts} />
          <PolicyProducts name={`${placement}-excludes`} label="Excluded products" values={policy?.excludes} />
          <PolicyProducts name={`${placement}-fallback`} label="Curated fallback products" values={policy?.fallback} />
          {placement === "buy-again" && <PolicyProducts name={`${placement}-replenishable`} label="Replenishable products" values={policy?.replenishable} />}
        </div>
      </details>;
    })}
    <div className="homepage-editor-actions">
      <button className="button button--primary" type="submit" disabled={waiting}>Save recommendation draft</button>
    </div>
    {message?.error ? <p role="alert">{message.error}</p> : <p role="status">{message?.success}</p>}
  </form>;
}

import { marketList } from "@/config/markets";
import { money } from "../acquisition/market-summary";

export function workflowMoney(value: number | null, currency: string | null) {
  if (value === null || !currency) return "Unavailable";
  const market = marketList.find(item => item.currency === currency);
  return market ? money(BigInt(value), market) : `${value} ${currency} minor units`;
}

export function workflowObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function workflowInternalHref(raw: unknown) {
  if (typeof raw !== "string" || !/^\/staff\/(?:acquisition|intelligence|workflows|homepage|catalog)(?:[/?#]|$)/.test(raw) || /[\\\p{Cc}]/u.test(raw)) return undefined;
  return raw;
}

export function WorkflowDetails({ value }: { value: Record<string, unknown> }) {
  const choices = Object.entries(value).filter(([key, entry]) => !["reference", "source", "experiment"].includes(key) && entry !== null);
  if (!choices.length) return null;
  return <dl className="workflow-lexicon">{choices.map(([key, entry]) => <div key={key}>
    <dt>{key.replace(/([A-Z])/g, " $1").replace(/^./, char => char.toUpperCase())}</dt>
    <dd>{typeof entry === "string" || typeof entry === "number" ? entry : typeof entry === "boolean" ? entry ? "Yes" : "No"
      : Array.isArray(entry) && entry.every(item => typeof item === "string") ? entry.join(" · ") : <pre className="workflow-result">{JSON.stringify(entry, null, 2)}</pre>}</dd>
  </div>)}</dl>;
}

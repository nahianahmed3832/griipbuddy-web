import { validVariantId } from "../cart/model.ts";

export type ChoiceValue = { id: string; value: string; label: string };
export type ChoiceAxis = { id: string; key: string; label: string; values: readonly ChoiceValue[] };
export type VariantChoice = { id: string; options: readonly { optionId: string | null; valueId: string | null }[] };
export type Picks = Readonly<Record<string, string>>;
const emptyPicks: Picks = {};

function canonical(value: string) {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function isModelChoice(axis: ChoiceAxis) {
  return /model|device|handset/i.test(axis.key);
}

function optionPicks(variant: VariantChoice): Picks {
  return Object.fromEntries(variant.options.flatMap(({ optionId, valueId }) => optionId && valueId ? [[optionId, valueId]] : []));
}

function hasChoice(variant: VariantChoice, axisId: string, valueId: string) {
  return variant.options.some(option => option.optionId === axisId && option.valueId === valueId);
}

export function matchesProductChoice(variant: VariantChoice, picks: Picks) {
  return Object.entries(picks).every(([axis, value]) => hasChoice(variant, axis, value));
}

export function exactChoice<T extends VariantChoice>(axes: readonly ChoiceAxis[], variants: readonly T[], picks: Picks): T | undefined {
  if (!axes.every(axis => Object.hasOwn(picks, axis.id))) return undefined;
  const matching = variants.filter(variant => matchesProductChoice(variant, picks));
  return matching.length === 1 ? matching[0] : undefined;
}

export function readProductChoice<T extends VariantChoice>(axes: readonly ChoiceAxis[], variants: readonly T[], params: URLSearchParams) {
  const requested = params.getAll("variant");
  if (requested.length) {
    if (requested.length !== 1 || !validVariantId(requested[0])) {
      return { picks: emptyPicks, selected: undefined, issue: "invalid" as const };
    }
    const selected = variants.find(variant => variant.id === requested[0]);
    return { picks: selected ? optionPicks(selected) : emptyPicks, selected, issue: selected ? null : "unavailable" as const };
  }
  const submitted = params.getAll("option");
  if (submitted.length > 24) return { picks: emptyPicks, selected: undefined, issue: "invalid-options" as const };
  const values = new Map<string, string>();
  let invalid = false;
  for (const entry of submitted) {
    const separator = entry.indexOf(":");
    if (separator < 1 || entry.length > 200 || /\p{Cc}/u.test(entry)) {
      invalid = true;
      continue;
    }
    const key = canonical(entry.slice(0, separator));
    const rawValue = canonical(entry.slice(separator + 1));
    // A stable selector URL must keep its meaning even when a catalog value uses the same text.
    const axis = axes.find(axis => canonical(axis.id) === key) ?? axes.find(axis => canonical(axis.key) === key);
    const value = axis?.values.find(value => canonical(value.id) === rawValue)
      ?? axis?.values.find(value => canonical(value.value) === rawValue);
    if (!axis || !value || values.has(axis.id) && values.get(axis.id) !== value.id) {
      invalid = true;
      continue;
    }
    values.set(axis.id, value.id);
  }
  const picks: Picks = Object.fromEntries(values);
  const issue = invalid || submitted.length && !variants.some(variant => matchesProductChoice(variant, picks)) ? "invalid-options" as const : null;
  return { picks, selected: issue ? undefined : exactChoice(axes, variants, picks), issue };
}

export function chooseProductOption<T extends VariantChoice>(
  axes: readonly ChoiceAxis[], variants: readonly T[], previous: Picks, axisId: string, valueId: string,
) {
  const axis = axes.find(item => item.id === axisId);
  if (!axis?.values.some(value => value.id === valueId)) return null;
  const matching = variants.filter(variant => hasChoice(variant, axisId, valueId));
  if (!matching.length) return null;

  const otherAxes = axes.filter(other => other.id !== axisId && Object.hasOwn(previous, other.id));
  let best: { retained: ChoiceAxis[]; models: number } | undefined;
  for (const variant of matching) {
    const retained = otherAxes.filter(other => hasChoice(variant, other.id, previous[other.id]));
    const models = retained.filter(isModelChoice).length;
    if (!best || models > best.models || models === best.models && retained.length > best.retained.length) {
      best = { retained, models };
    }
  }

  // Keep only the shopper's own selections. A compatible row can inform what survives,
  // but its unchosen values must never become selections automatically.
  const choices = new Map<string, string>([[axisId, valueId]]);
  const retained = new Set(best?.retained);
  const cleared: string[] = [];
  for (const other of otherAxes) {
    if (retained.has(other)) choices.set(other.id, previous[other.id]);
    else cleared.push(other.label);
  }
  const picks = Object.fromEntries(choices);
  return { picks, selected: exactChoice(axes, matching, picks), cleared };
}

export function writeProductChoice(params: URLSearchParams, axes: readonly ChoiceAxis[], picks: Picks, variantId?: string) {
  const updated = new URLSearchParams(params);
  updated.delete("variant");
  updated.delete("option");
  if (variantId) {
    updated.set("variant", variantId);
  } else {
    for (const { id } of axes) if (Object.hasOwn(picks, id)) updated.append("option", `${id}:${picks[id]}`);
  }
  return updated;
}

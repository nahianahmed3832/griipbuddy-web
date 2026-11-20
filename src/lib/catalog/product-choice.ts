import { validVariantId } from "../cart/model.ts";

export type ChoiceValue = { id: string; value: string; label: string };
export type ChoiceAxis = { id: string; key: string; label: string; values: readonly ChoiceValue[] };
export type VariantChoice = { id: string; options: readonly { optionId: string | null; valueId: string | null }[] };
export type Picks = Readonly<Record<string, string>>;
const emptyPicks: Picks = {};

function canonical(value: string) {
  return value.trim().normalize("NFKC").toLowerCase();
}

function optionPicks(variant: VariantChoice): Picks {
  return Object.fromEntries(variant.options.flatMap(({ optionId, valueId }) => optionId && valueId ? [[optionId, valueId]] : []));
}

function matches(variant: VariantChoice, picks: Picks) {
  return Object.entries(picks).every(([axis, value]) =>
    variant.options.some(option => option.optionId === axis && option.valueId === value));
}

export function exactChoice<T extends VariantChoice>(axes: readonly ChoiceAxis[], variants: readonly T[], picks: Picks): T | undefined {
  if (!axes.every(axis => Object.hasOwn(picks, axis.id))) return undefined;
  const matching = variants.filter(variant => matches(variant, picks));
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
    const axis = axes.find(axis => canonical(axis.id) === key || canonical(axis.key) === key);
    const value = axis?.values.find(value => canonical(value.id) === rawValue || canonical(value.value) === rawValue);
    if (!axis || !value || values.has(axis.id) && values.get(axis.id) !== value.id) {
      invalid = true;
      continue;
    }
    values.set(axis.id, value.id);
  }
  const picks: Picks = Object.fromEntries(values);
  const issue = invalid || submitted.length && !variants.some(variant => matches(variant, picks)) ? "invalid-options" as const : null;
  return { picks, selected: issue ? undefined : exactChoice(axes, variants, picks), issue };
}

export function chooseProductOption<T extends VariantChoice>(
  axes: readonly ChoiceAxis[], variants: readonly T[], previous: Picks, axisId: string, valueId: string,
) {
  const axis = axes.find(item => item.id === axisId);
  if (!axis?.values.some(value => value.id === valueId)) return null;
  let matching = variants.filter(variant => matches(variant, { [axis.id]: valueId }));
  if (!matching.length) return null;
  const choices = new Map<string, string>([[axis.id, valueId]]);
  const cleared: string[] = [];
  for (const other of axes) {
    const previousValue = previous[other.id];
    if (other.id === axis.id || !previousValue) continue;
    const withPrevious = matching.filter(variant => matches(variant, { [other.id]: previousValue }));
    if (withPrevious.length) {
      choices.set(other.id, previousValue);
      matching = withPrevious;
    } else {
      cleared.push(other.label);
    }
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

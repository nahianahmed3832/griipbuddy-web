"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import type { SellerListingVariant as ListingVariant } from "@/lib/marketplace/listing-review-input";

type Option = { name: string; value: string };
export type ListingVariantEdit = Omit<ListingVariant, "options" | "amountMinor"> & {
  key: string;
  options: Option[];
  price: string;
  wasRetired?: boolean;
};

const maxVariants = 24;
const maxOptions = 4;
const skuPattern = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;
const inputSku = "[A-Z0-9][A-Z0-9_\\-]{0,31}";
const optionPattern = /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u;
const emptyOption = { name: "", value: "" };

export function editListingVariants(variants: ListingVariant[], minorDigits: number): ListingVariantEdit[] {
  return variants.map(({ amountMinor, options, ...row }, index) => ({
    ...row,
    key: row.id ?? String(index),
    options: Object.entries(options).map(([name, value]) => ({ name, value })),
    price: amountMinor === null ? "" : (amountMinor / 10 ** minorDigits).toFixed(minorDigits),
    wasRetired: row.retired,
  }));
}

function parsePrice(value: string, minorDigits: number) {
  if (!value.trim()) return null;
  const amount = /^(\d+)(?:\.(\d+))?$/u.exec(value.trim());
  if (!amount || (amount[2]?.length ?? 0) > minorDigits) throw new Error("Enter a price with the allowed currency precision.");
  const minor = Number(amount[1]) * 10 ** minorDigits + Number((amount[2] ?? "").padEnd(minorDigits, "0"));
  if (!Number.isSafeInteger(minor) || minor < 1 || minor > 15_000_000) throw new Error("Enter a positive price within the available range.");
  return minor;
}

function optionKey(name: string) {
  return name.normalize("NFKC").trim().toLowerCase().replace(/[ _-]+/gu, "-");
}

function combinationKey(options: readonly Option[]) {
  return JSON.stringify(options.map(({ name, value }) => [optionKey(name), value.normalize("NFKC").trim().toLowerCase()]).sort(
    ([left], [right]) => left.localeCompare(right, "en"),
  ));
}

export function saveListingVariants(variants: ListingVariantEdit[], minorDigits: number): ListingVariant[] {
  const skus = new Set<string>();
  const combinations = new Set<string>();
  const dimensions = new Set<string>();
  return variants.map(({ id, sku: rawSku, label, options, price, isDefault, retired }, index) => {
    const sku = rawSku.trim().toUpperCase();
    const reference = sku || `Variant ${index + 1}`;
    if (!skuPattern.test(sku)) throw new Error(`${reference} needs a SKU with letters, numbers, dashes or underscores.`);
    if (skus.has(sku)) throw new Error(`SKU ${sku} appears more than once.`);
    skus.add(sku);
    const pairs = options.map(({ name, value }) => [name.trim(), value.trim()] as const);
    const optionNames = pairs.map(([name]) => optionKey(name));
    if (pairs.some(([name, value]) => !optionPattern.test(name) || !value) || new Set(optionNames).size !== pairs.length) {
      throw new Error(`${reference} needs one value for each unique option name.`);
    }
    dimensions.add(JSON.stringify(optionNames.sort()));
    if (dimensions.size > 1) throw new Error("Use the same option names on each variant.");
    const signature = combinationKey(options);
    if (combinations.has(signature)) throw new Error(`${reference} repeats an existing option combination.`);
    combinations.add(signature);
    let amountMinor: number | null;
    try {
      amountMinor = retired ? null : parsePrice(price, minorDigits);
    } catch (error) {
      throw new Error(`${reference} · ${error instanceof Error ? error.message : "Enter a valid price."}`);
    }
    const variantLabel = label.trim() || pairs.map(([, value]) => value).join(" / ").slice(0, 80) || "Standard";
    return { ...(id && { id }), sku, label: variantLabel, options: Object.fromEntries(pairs), amountMinor, isDefault, retired };
  });
}

function newVariant(options: Option[], isDefault: boolean): ListingVariantEdit {
  return {
    key: crypto.randomUUID(), sku: "", label: options.map(({ value }) => value).join(" / ").slice(0, 80) || "Standard",
    options, price: "", isDefault,
  };
}

function CombinationBuilder({ variants, add }: { variants: ListingVariantEdit[]; add: (rows: ListingVariantEdit[]) => void }) {
  const [axes, setAxes] = useState<Option[]>([{ ...emptyOption }]);
  const [message, setMessage] = useState<{ type: "alert" | "status"; text: string }>();
  function generate() {
    const parsed = axes.map(({ name, value }) => ({
      name: name.trim(), values: [...new Map(value.split(",").map(item => item.trim()).filter(Boolean)
        .map(item => [item.toLowerCase(), item])).values()],
    }));
    if (parsed.some(({ name, values }) => !optionPattern.test(name) || !values.length || values.some(value => value.length > 70)) ||
      new Set(parsed.map(({ name }) => optionKey(name))).size !== parsed.length) {
      setMessage({ type: "alert", text: "Enter different option names and at least one value up to 70 characters for each." });
      return;
    }
    const count = parsed.reduce((total, { values }) => total * values.length, 1);
    if (count > maxVariants) {
      setMessage({ type: "alert", text: `Generate up to ${maxVariants} combinations at a time. Use fewer values or add a row manually.` });
      return;
    }
    const existing = new Set(variants.map(row => combinationKey(row.options)));
    const combinations = parsed.reduce<Option[][]>((rows, { name, values }) =>
      rows.flatMap(row => values.map(value => [...row, { name, value }])), [[]]).filter(row => !existing.has(combinationKey(row)));
    if (!combinations.length || combinations.length + variants.length > maxVariants) {
      setMessage({ type: "alert", text: combinations.length ? `This listing has room for ${maxVariants - variants.length} more variants.`
        : "These option combinations are already in the listing." });
      return;
    }
    add(combinations.map((options, index) => newVariant(options, index === 0 && !variants.some(row => !row.retired))));
    setMessage({ type: "status", text: `${combinations.length} new ${combinations.length === 1 ? "row" : "rows"} added. Enter a SKU for each.` });
  }

  return <details className="seller-variant-builder">
    <summary>Generate combinations</summary>
    <p className="seller-muted">Enter comma-separated values for options such as colour and size.</p>
    {axes.map((axis, index) => <div className="seller-editor-grid" key={index}>
      <label>Option {index + 1} name<input value={axis.name} maxLength={40} placeholder="Colour"
        onChange={event => setAxes(axes.map((row, position) => position === index ? { ...row, name: event.target.value } : row))}/></label>
      <label>Option {index + 1} values<input value={axis.value} maxLength={1000} placeholder="Blue, Sand"
        onChange={event => setAxes(axes.map((row, position) => position === index ? { ...row, value: event.target.value } : row))}/></label>
      {axes.length > 1 && <button className="seller-button" type="button"
        onClick={() => setAxes(axes.filter((_, position) => position !== index))}>Remove option {index + 1}</button>}
    </div>)}
    <div className="seller-actions">
      <button type="button" className="seller-button" disabled={axes.length >= maxOptions}
        onClick={() => setAxes([...axes, { ...emptyOption }])}>Add option</button>
      <button type="button" className="seller-button" onClick={generate}>Add combinations</button>
    </div>
    {message && <p className={message.type === "alert" ? "seller-field-error" : "seller-muted"} role={message.type}>{message.text}</p>}
  </details>;
}

export function SellerListingVariants({ variants, change, allowEditing, allowSharedEditing, currency, minorDigits }: {
  variants: ListingVariantEdit[];
  change: (next: ListingVariantEdit[]) => void;
  allowEditing: boolean;
  allowSharedEditing: boolean;
  currency: string;
  minorDigits: number;
}) {
  function update(key: string, fields: Partial<ListingVariantEdit>) {
    change(variants.map(row => row.key === key ? { ...row, ...fields } : row));
  }

  function remove(row: ListingVariantEdit) {
    const next = row.id ? variants.map(item => item.key === row.key ? { ...item, retired: true, isDefault: false } : item)
      : variants.filter(item => item.key !== row.key);
    const nextDefault = row.isDefault ? next.find(item => !item.retired)?.key : undefined;
    change(nextDefault ? next.map(item => item.key === nextDefault ? { ...item, isDefault: true } : item) : next);
  }

  return <section className="seller-panel" id="variants" aria-labelledby="listing-variants-title">
    <div className="seller-panel-heading">
      <div>
        <h2 id="listing-variants-title">Variants and prices</h2>
        <p className="seller-muted">Prices are in {currency} for this market. Leave a price blank to omit the offer. New variants start with zero stock.</p>
      </div>
      {allowSharedEditing && <button className="seller-button" type="button" disabled={variants.length >= maxVariants}
        onClick={() => change([...variants, newVariant([], !variants.some(row => !row.retired))])}>
        <Plus aria-hidden="true" size={15}/> Add variant
      </button>}
    </div>
    {allowSharedEditing && variants.length < maxVariants && <CombinationBuilder variants={variants} add={rows => change([...variants, ...rows])}/>}
    {variants.length === 0 ? <p className="seller-muted">Add a standard variant or generate combinations from product options.</p>
      : <div className="seller-table-wrap"><table className="seller-table seller-variant-table" aria-labelledby="listing-variants-title">
        <thead><tr><th scope="col">Combination</th><th scope="col">SKU</th><th scope="col">Price ({currency})</th>
          <th scope="col">Default</th><th scope="col">Status</th></tr></thead>
        <tbody>{variants.map((row, index) => {
          const reference = row.sku || `variant ${index + 1}`;
          const saved = Boolean(row.id);
          const editable = allowEditing && !row.retired;
          const canChangeVariant = allowSharedEditing && !row.retired;
          const canChangeIdentity = canChangeVariant && !saved;
          const tuple = row.options.map(({ name, value }) => name && value ? `${name} · ${value}` : value).filter(Boolean).join(" / ");
          return <tr key={row.key}>
            <td data-label="Combination">
              <div className="seller-variant-combination">
                <input aria-label={`Label for ${reference}`} maxLength={80} placeholder="Variant label" value={row.label}
                  readOnly={!canChangeVariant} onChange={event => update(row.key, { label: event.target.value })}/>
                {canChangeIdentity ? <details><summary>{tuple || "Edit option values"}</summary>
                  {row.options.map((option, position) => <div className="seller-variant-option" key={position}>
                    <label>Option name<input value={option.name} maxLength={40} onChange={event => update(row.key, {
                      options: row.options.map((item, optionIndex) => position === optionIndex ? { ...item, name: event.target.value } : item),
                    })}/></label>
                    <label>Value<input value={option.value} maxLength={70} onChange={event => update(row.key, {
                      options: row.options.map((item, optionIndex) => position === optionIndex ? { ...item, value: event.target.value } : item),
                    })}/></label>
                    <button type="button" className="seller-button" onClick={() => update(row.key, {
                      options: row.options.filter((_, optionIndex) => position !== optionIndex),
                    })}>Remove option</button>
                  </div>)}
                  {row.options.length < maxOptions && <button type="button" className="seller-button" onClick={() => update(row.key, {
                    options: [...row.options, { ...emptyOption }],
                  })}>Add option value</button>}
                </details> : tuple && <small>{tuple}</small>}
              </div>
            </td>
            <td data-label="SKU"><input aria-label={`SKU for variant ${index + 1}`} value={row.sku} maxLength={32} pattern={inputSku}
              readOnly={!canChangeIdentity} onChange={event => update(row.key, { sku: event.target.value.toUpperCase() })}/></td>
            <td data-label={`Price (${currency})`}><input aria-label={`Price in ${currency} for ${reference}`} inputMode="decimal"
              placeholder={(0).toFixed(minorDigits)} value={row.price} maxLength={14}
              readOnly={!editable} onChange={event => update(row.key, { price: event.target.value })}/></td>
            <td data-label="Default"><input type="radio" name="defaultVariant" aria-label={`Set ${reference} as default`}
              checked={row.isDefault} disabled={!canChangeVariant} onChange={() => change(variants.map(item => ({
                ...item, isDefault: item.key === row.key,
              })))}/></td>
            <td data-label="Status"><div className="seller-variant-status">
              <span className="seller-status" data-tone={row.retired ? "muted" : saved ? "positive" : "warning"}>
                {row.retired ? row.wasRetired ? "Retired" : "Retirement staged" : saved ? "Active" : "Draft"}
              </span>
              {canChangeVariant && <button type="button" className="seller-button" onClick={() => remove(row)}
                aria-label={`${saved ? "Retire" : "Remove"} ${reference}`}>{saved ? "Retire" : "Remove"}</button>}
              {allowSharedEditing && row.retired && !row.wasRetired &&
                <button type="button" className="seller-button" onClick={() => update(row.key, {
                  retired: false, isDefault: !variants.some(item => item.isDefault),
                })}>Undo retirement</button>}
            </div></td>
          </tr>;
        })}</tbody>
      </table></div>}
  </section>;
}

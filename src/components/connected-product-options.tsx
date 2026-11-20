"use client";

import Image from "next/image";
import { useId, useState } from "react";
import { storefrontPath } from "@/config/storefront-path";
import type { PublicCatalogVariant } from "@/lib/catalog/connected-public";
import { chooseProductOption, type ChoiceAxis, type Picks } from "@/lib/catalog/product-choice";
import { catalogSearchKey } from "@/lib/catalog/search-match";

const swatches: Record<string, string> = {
  black: "#252426", blue: "#546c9a", brown: "#795a49", charcoal: "#47474b", cream: "#eee1c7",
  green: "#567756", grey: "#797d84", gray: "#797d84", lilac: "#ae94b8", navy: "#283953",
  orange: "#ae582c", pink: "#d597a9", purple: "#745080", red: "#9c323d", silver: "#a4a7af",
  white: "#fff", yellow: "#ecc75d",
};

export function ConnectedProductOptions({ axes, variants, picks, onChoose }: {
  axes: readonly ChoiceAxis[]; variants: readonly PublicCatalogVariant[]; picks: Picks;
  onChoose: (axis: string, value: string) => void;
}) {
  return <div className="connected-product-options" role="group" aria-label="Product options">
    {axes.map(axis => <OptionGroup key={axis.id} {...{ axis, axes, variants, picks, onChoose }} />)}
  </div>;
}

function OptionGroup({ axis, axes, variants, picks, onChoose }: {
  axis: ChoiceAxis; axes: readonly ChoiceAxis[]; variants: readonly PublicCatalogVariant[]; picks: Picks;
  onChoose: (axis: string, value: string) => void;
}) {
  const [search, setSearch] = useState("");
  const id = useId();
  const key = axis.key.toLowerCase();
  const selected = picks[axis.id] ?? "";
  const model = /(?:model|device|handset)/.test(key);
  const query = model ? catalogSearchKey(search) : "";
  const choicesFor = (valueId: string) => variants.filter(variant =>
    variant.options.some(option => option.optionId === axis.id && option.valueId === valueId));
  const matched = query ? axis.values.filter(value => {
    const canonical = [value.value, value.label].map(catalogSearchKey);
    if (canonical.some(name => name.includes(query))) return true;
    return choicesFor(value.id).some(variant => variant.compatibility.some(item => {
      const names = [item.name, `${item.brand} ${item.name}`].map(catalogSearchKey);
      return names.some(name => canonical.includes(name)) && item.aliases.some(alias => catalogSearchKey(alias).includes(query));
    }));
  }) : axis.values;
  const selectedValue = axis.values.find(value => value.id === selected);
  const matching = selectedValue && !matched.includes(selectedValue) ? [selectedValue, ...matched] : matched;
  const visual = /design|style|pattern/.test(key);
  const color = /colou?r/.test(key);
  return <fieldset className="connected-option-group">
    <legend>{axis.label}</legend>
    {model && axis.values.length > 1 && <label className="store-dialog__field">Search {axis.label.toLowerCase()} options
      <input type="search" value={search} onChange={event => setSearch(event.target.value)} />
    </label>}
    {model && axis.values.length > 8 ? <label className="store-dialog__field">Choose {axis.label.toLowerCase()}
      <select value={selected} onChange={event => { if (event.target.value) onChoose(axis.id, event.target.value); }}>
        <option value="">Choose an option</option>
        {matching.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}
      </select>
    </label> : <div className={visual ? "connected-option-list connected-option-list--visual" : "connected-option-list"}>
      {matching.map(value => {
        const next = chooseProductOption(axes, variants, picks, axis.id, value.id);
        const choices = choicesFor(value.id);
        const image = visual && next ? next.selected?.image ?? choices.find(variant => variant.image &&
          Object.entries(next.picks).every(([optionId, valueId]) =>
            variant.options.some(option => option.optionId === optionId && option.valueId === valueId)))?.image : null;
        const colorKey = value.value.trim().toLowerCase();
        const swatch = color && Object.hasOwn(swatches, colorKey) ? swatches[colorKey] : undefined;
        const hint = choices.every(variant => !variant.offer.eligible) ? "Browse only"
          : next?.cleared.length ? `Choose ${next.cleared.join(" and ")} again` : null;
        return <label className="connected-option" key={value.id}>
          <input type="radio" name={`connected-option-${axis.id}`} value={value.id} checked={selected === value.id}
            aria-label={value.label} aria-describedby={hint ? `${id}-${value.id}` : undefined}
            disabled={!next} onChange={() => onChoose(axis.id, value.id)} />
          {visual && image && <span className="connected-option__thumb">
            <Image src={storefrontPath(image.src)} alt="" fill sizes="86px" unoptimized />
          </span>}
          <span className="connected-option__label">
            {swatch && <span className="connected-option__swatch" style={{ backgroundColor: swatch }} aria-hidden="true" />}
            {value.label}
          </span>
          {hint && <small id={`${id}-${value.id}`}>{hint}</small>}
        </label>;
      })}
    </div>}
    {model && !matched.length && <p role="status">No matching models.</p>}
  </fieldset>;
}

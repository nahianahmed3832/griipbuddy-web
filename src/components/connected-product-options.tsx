"use client";

import Image from "next/image";
import { useId, useMemo, useState } from "react";
import { storefrontPath } from "@/config/storefront-path";
import type { PublicCatalogVariant } from "@/lib/catalog/connected-public";
import { chooseProductOption, isModelChoice, matchesProductChoice, type ChoiceAxis, type Picks } from "@/lib/catalog/product-choice";
import { catalogSearchKey } from "@/lib/catalog/search-match";
import { optionColorSwatch } from "./option-color-swatch";

const designPreviewLimit = 12;

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
  const [showAll, setShowAll] = useState(false);
  const id = useId();
  const key = axis.key.toLowerCase();
  const selected = picks[axis.id] ?? "";
  const model = isModelChoice(axis);
  const longList = axis.values.length > 8;
  const selectModel = model && longList;
  const visual = /design|style|pattern/.test(key);
  const color = /colou?r/.test(key);
  const query = catalogSearchKey(search);
  const variantsByValue = useMemo(() => {
    const groups = new Map<string, PublicCatalogVariant[]>();
    for (const variant of variants) {
      const valueId = variant.options.find(option => option.optionId === axis.id)?.valueId;
      if (!valueId) continue;
      const choices = groups.get(valueId) ?? [];
      choices.push(variant);
      groups.set(valueId, choices);
    }
    return groups;
  }, [axis.id, variants]);
  const matched = query ? axis.values.filter(value => {
    const canonical = [value.value, value.label].map(catalogSearchKey);
    if (canonical.some(name => name.includes(query))) return true;
    if (!model) return false;
    return variantsByValue.get(value.id)?.some(variant => variant.compatibility.some(item => {
      const names = [item.name, `${item.brand} ${item.name}`].map(catalogSearchKey);
      return names.some(name => canonical.includes(name)) && item.aliases.some(alias => catalogSearchKey(alias).includes(query));
    }));
  }) : axis.values;
  const selectedValue = axis.values.find(value => value.id === selected);
  const matching = selectedValue && !matched.includes(selectedValue) ? [selectedValue, ...matched] : matched;
  const limited = visual && !selectModel && matching.length > designPreviewLimit;
  const previews = matching.slice(0, designPreviewLimit);
  const visible = limited && !showAll
    ? selectedValue && !previews.includes(selectedValue) ? [...previews.slice(0, -1), selectedValue] : previews
    : matching;
  const searchLabel = `Search ${axis.label.toLowerCase()} options`;

  return <fieldset className="connected-option-group">
    <legend>{axis.label}</legend>
    {(model && axis.values.length > 1 || longList) && <label className="store-dialog__field">{searchLabel}
      <input type="search" maxLength={120} value={search} onChange={event => { setSearch(event.target.value); setShowAll(false); }} />
    </label>}
    {selectModel ? <label className="store-dialog__field">Choose {axis.label.toLowerCase()}
      <select value={selected} onChange={event => { if (event.target.value) onChoose(axis.id, event.target.value); }}>
        <option value="">Choose an option</option>
        {matching.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}
      </select>
    </label> : <div id={id} className={visual ? "connected-option-list connected-option-list--visual" : "connected-option-list"}>
      {visible.map(value => {
        const choices = variantsByValue.get(value.id) ?? [];
        const next = chooseProductOption(axes, choices, picks, axis.id, value.id);
        const image = visual && next ? next.selected?.gallery[0] ?? choices.find(variant =>
          variant.gallery.length && matchesProductChoice(variant, next.picks))?.gallery[0] : undefined;
        const swatch = color ? optionColorSwatch(value.value) ?? optionColorSwatch(value.label) : undefined;
        const hint = choices.every(variant => !variant.offer.eligible) ? "Browse only"
          : next?.cleared.length ? `Choose ${next.cleared.join(" and ")} again` : null;
        return <label className="connected-option" key={value.id}>
          <input type="radio" name={id} value={value.id} checked={selected === value.id}
            aria-label={value.label} aria-describedby={hint ? `${id}-${value.id}` : undefined}
            disabled={!next} onChange={() => onChoose(axis.id, value.id)} />
          {visual && <span className="connected-option__thumb" data-empty={!image} aria-hidden="true">
            {image && <Image src={storefrontPath(image.src)} alt="" fill sizes="86px" unoptimized={image.src.startsWith("/media/")} />}
          </span>}
          <span className="connected-option__label">
            {swatch && <span className="connected-option__swatch" style={{ backgroundColor: swatch }} aria-hidden="true" />}
            <span>{value.label}</span>
          </span>
          {hint && <small id={`${id}-${value.id}`}>{hint}</small>}
        </label>;
      })}
    </div>}
    {limited && <button type="button" className="button button--outline connected-option-more" aria-expanded={showAll}
      aria-controls={id} onClick={() => setShowAll(value => !value)}>
      {showAll ? "Show fewer options" : `Show all ${matching.length} options`}
    </button>}
    {!matched.length && <p role="status">{model ? "No matching models." : "No matching options."}</p>}
  </fieldset>;
}

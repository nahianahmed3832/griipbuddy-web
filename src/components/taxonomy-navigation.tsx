"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import type { EditableMarketMenuItem } from "@/lib/staff/navigation";
import type { NavigationWorkspaceData } from "@/lib/staff/navigation-workspace";
import { runCatalogCommand, TaxonomyFeedback, useConfirmTaxonomyNavigation, useTaxonomyDirty, useTaxonomyOperation } from "./taxonomy-controls";
import "./taxonomy-editorial.css";

type Target = { key: string; label: string; href: string; visible: boolean; item: EditableMarketMenuItem };
type MenuRow = { key: number; item: EditableMarketMenuItem };

function itemKey(item: EditableMarketMenuItem) {
  if (item.type === "category") return `category:${item.categoryId}`;
  if (item.type === "collection") return `collection:${item.collectionId}`;
  return `page:${item.page}`;
}

function menuOptions(data: NavigationWorkspaceData) {
  const categories = data.categories.map(category => ({ ...category, key: `category:${category.id}`,
    item: { type: "category", categoryId: category.id, visible: true } as const }));
  const collections = data.collections.map(collection => ({ ...collection, key: `collection:${collection.id}`,
    item: { type: "collection", collectionId: collection.id, visible: true } as const }));
  const pages = data.pages.map(page => ({ ...page, key: `page:${page.page}`,
    item: { type: "page", page: page.page, visible: true } as const }));
  return [
    { label: "Categories", targets: categories },
    { label: "Published collections", targets: collections },
    { label: "Store pages", targets: pages },
  ] satisfies { label: string; targets: Target[] }[];
}

export function TaxonomyNavigation({ data }: { data: NavigationWorkspaceData }) {
  const router = useRouter();
  const confirm = useConfirmTaxonomyNavigation();
  const operation = useTaxonomyOperation();
  const setDirty = useTaxonomyDirty();
  const nextKey = useRef(data.items.length);
  const [revision, setRevision] = useState(data.revision);
  const [rows, setRows] = useState(() => data.items.map((item, key) => ({ key, item })));
  const groups = menuOptions(data);
  const targets = new Map<string, Target>(groups.flatMap(group => group.targets.map(target => [target.key, target])));

  function edit(next: MenuRow[]) {
    setRows(next);
    setDirty(true);
  }

  function update(key: number, item: EditableMarketMenuItem) {
    edit(rows.map(row => row.key === key ? { ...row, item } : row));
  }

  function move(index: number, offset: number) {
    const next = [...rows];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    edit(next);
  }

  function openMenu(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirm()) return;
    const values = new FormData(event.currentTarget);
    const query = new URLSearchParams({ view: "navigation", menuKey: String(values.get("menuKey")), menuLocale: String(values.get("menuLocale")) });
    setDirty(false);
    router.push(`/staff/catalog/taxonomy?${query}`);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const success = await operation.run(async () => {
      const result = await runCatalogCommand<{ revision: number }>("menu.save", {
        marketId: data.marketId, key: data.key, locale: data.locale, expectedRevision: revision,
        items: rows.map(row => ({ ...row.item, label: row.item.label?.trim() || null })),
      });
      setRevision(result.revision);
    }, "Menu saved.");
    if (success) setDirty(false);
  }

  const preview = rows.flatMap(({ key, item }) => {
    const target = targets.get(itemKey(item));
    return item.visible && target?.visible ? [{ key, label: item.label?.trim() || target.label, href: target.href }] : [];
  });

  return <div className="commerce-stack">
    <section className="commerce-panel taxonomy-card" aria-labelledby="navigation-context">
      <h2 id="navigation-context">Market menus</h2>
      <form onSubmit={openMenu} className="commerce-form taxonomy-form">
        <div className="commerce-fields">
          <label>Menu key<input name="menuKey" defaultValue={data.key} list="taxonomy-menu-keys" required
            maxLength={120} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label>
          <datalist id="taxonomy-menu-keys">{data.existingKeys.map(key => <option key={key} value={key} />)}</datalist>
          <label>Menu language<select name="menuLocale" defaultValue={data.locale}>
            <option value="">Market default</option>
            {data.languages.map(locale => <option key={locale} value={locale}>{locale}</option>)}
          </select></label>
        </div>
        <div className="taxonomy-actions"><button className="button button--outline" type="submit">Open menu</button></div>
      </form>
    </section>
    <div className="taxonomy-editorial-grid">
    <section className="commerce-panel taxonomy-card" aria-labelledby="navigation-items">
      <h2 id="navigation-items">Links</h2>
      <p className="taxonomy-muted">{data.marketName} · {data.locale || "Market default"} · {data.key}</p>
      {data.inheritsMenu && revision === null && <p>Saving creates a separate language menu using the market menu as a starting point.</p>}
      <form onSubmit={save} className="commerce-form taxonomy-form">
        {rows.length === 0 ? <p className="taxonomy-muted">Add a category, published collection, or store page.</p> :
          <ol className="commerce-stack taxonomy-editor-list">
            {rows.map(({ key, item }, index) => {
              const selected = targets.get(itemKey(item));
              const itemName = item.label?.trim() || selected?.label || `link ${index + 1}`;
              return <li key={key}>
                <fieldset disabled={operation.pending}>
                  <legend>Link {index + 1}</legend>
                  <div className="commerce-fields">
                    <label>Link target
                      <select value={itemKey(item)} onChange={event => {
                        const choice = targets.get(event.currentTarget.value);
                        if (choice) update(key, { ...choice.item, label: item.label, visible: item.visible });
                      }}>
                        {!selected && <option value={itemKey(item)}>Unavailable target</option>}
                        {groups.map(group => <optgroup label={group.label} key={group.label}>
                          {group.targets.map(target => <option key={target.key} value={target.key}>
                            {target.label}{target.visible ? "" : " (hidden in this market)"}
                          </option>)}
                        </optgroup>)}
                      </select>
                    </label>
                    <label>Custom label<input value={item.label ?? ""} maxLength={80}
                      placeholder={selected?.label} onChange={event => update(key, { ...item, label: event.currentTarget.value })} /></label>
                  </div>
                  <label className="taxonomy-check"><input type="checkbox" checked={item.visible}
                    onChange={event => update(key, { ...item, visible: event.currentTarget.checked })} />Show in menu</label>
                  {item.visible && !selected?.visible && <p className="taxonomy-muted">Hidden by the target’s market settings.</p>}
                  <div className="taxonomy-actions">
                    <button className="button button--outline" type="button" disabled={index === 0}
                      aria-label={`Move ${itemName} up`} onClick={() => move(index, -1)}>Move up</button>
                    <button className="button button--outline" type="button" disabled={index === rows.length - 1}
                      aria-label={`Move ${itemName} down`} onClick={() => move(index, 1)}>Move down</button>
                    <button className="button button--outline" type="button" aria-label={`Remove ${itemName}`}
                      onClick={() => edit(rows.filter(row => row.key !== key))}>Remove</button>
                  </div>
                </fieldset>
              </li>;
            })}
          </ol>}
        <div className="taxonomy-actions">
          <button className="button button--outline" type="button" disabled={operation.pending || rows.length >= 100}
            onClick={() => edit([...rows, { key: nextKey.current++, item: { type: "page", page: "SHOP", visible: true } }])}>Add link</button>
          <button className="button button--primary" type="submit" disabled={operation.pending}>{operation.pending ? "Saving…" : "Save menu"}</button>
        </div>
        <TaxonomyFeedback {...operation} />
      </form>
    </section>
    <section className="commerce-panel taxonomy-card taxonomy-editorial-sidebar" aria-labelledby="navigation-preview">
      <h2 id="navigation-preview">Menu preview</h2>
      <p className="taxonomy-muted">{data.marketName} · {data.previewLocale}</p>
      {preview.length ? <nav aria-label="Menu preview">
        <ol>{preview.map(item => <li key={item.key}><a href={item.href} className="text-link">{item.label}</a></li>)}</ol>
      </nav> : <p className="taxonomy-muted">No links are visible in this menu.</p>}
      <p>Menu visibility has no effect on product availability.</p>
    </section>
    </div>
  </div>;
}

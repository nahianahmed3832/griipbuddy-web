"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { storefrontPath } from "@/config/storefront-path";
import type { CollectionProductOption, CollectionWorkspaceData } from "@/lib/staff/navigation-workspace";
import { CatalogImageField } from "./catalog-image-field";
import { runCatalogCommand, TaxonomyFeedback, TaxonomyForm, useTaxonomyDirty, useTaxonomyOperation } from "./taxonomy-controls";
import "./taxonomy-editorial.css";

function collectionHref(id: string) {
  return `/staff/catalog/taxonomy?${new URLSearchParams({ view: "collections", collection: id })}`;
}

const selectionLabels = { CURATED: "Manual", NEW: "New arrivals", FEATURED: "Featured products" };

type SearchResult = { products: CollectionProductOption[]; count: number; page: number; pages: number };

function ProductSearch({ marketId, collectionId, onAdd, selected, disabled }: {
  marketId: string; collectionId: string; onAdd: (product: CollectionProductOption) => void;
  selected: ReadonlySet<string>; disabled: boolean;
}) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState({ q: "", page: 1 });
  const [result, setResult] = useState<{ query: typeof query; data?: SearchResult; error?: string }>();
  const data = result?.query === query ? result.data : undefined;
  const error = result?.query === query ? result.error : undefined;
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ marketId, collectionId, q: query.q, page: String(query.page) });
    fetch(storefrontPath(`/api/staff/catalog/collection-products?${params}`), { signal: controller.signal })
      .then(async response => {
        const payload: { data?: SearchResult; error?: { message: string } } = await response.json();
        if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "Product search could not load.");
        if (!controller.signal.aborted) setResult({ query, data: payload.data });
      }).catch((cause: unknown) => {
        if (!controller.signal.aborted) setResult({ query, error: cause instanceof Error ? cause.message : "Product search could not load." });
      });
    return () => controller.abort();
  }, [marketId, collectionId, query]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery({ q: input.trim(), page: 1 });
  }

  return <div className="commerce-stack">
    <form className="commerce-form taxonomy-form" onSubmit={search} role="search" aria-label="Collection products">
      <label>Find products<input type="search" value={input} maxLength={120} placeholder="Name, brand or SKU"
        onChange={event => setInput(event.currentTarget.value)} /></label>
      <div className="taxonomy-actions"><button className="button button--outline" type="submit">Search products</button></div>
    </form>
    {!data && !error && <p role="status">Loading products…</p>}
    {error && <TaxonomyFeedback error={error} />}
    {data && <>
      <p className="taxonomy-muted" role="status">{data.count} {data.count === 1 ? "product" : "products"} found</p>
      {data.products.length ? <div className="taxonomy-scroll">
        <table className="taxonomy-table">
          <thead><tr><th scope="col">Product</th><th scope="col">Catalog status</th><th scope="col">Current market</th><th scope="col">Add</th></tr></thead>
          <tbody>{data.products.map(product => <tr key={product.id}>
            <th scope="row">{product.name}</th><td>{product.publication.toLowerCase()}</td>
            <td>{product.visibleInMarket ? "Visible" : "Unavailable"}</td>
            <td><button className="button button--outline" type="button" aria-label={`Add ${product.name}`}
              disabled={disabled || selected.has(product.id) || selected.size >= 1000}
              onClick={() => onAdd(product)}>{selected.has(product.id) ? "Added" : "Add"}</button></td>
          </tr>)}</tbody>
        </table>
      </div> : <p className="taxonomy-muted">No products match this search.</p>}
      {data.pages > 1 && <div className="taxonomy-actions" aria-label="Product search pages">
        <button className="button button--outline" type="button" disabled={data.page === 1}
          onClick={() => setQuery({ ...query, page: data.page - 1 })}>Previous page</button>
        <p>Page {data.page} of {data.pages}</p>
        <button className="button button--outline" type="button" disabled={data.page >= data.pages}
          onClick={() => setQuery({ ...query, page: data.page + 1 })}>Next page</button>
      </div>}
    </>}
  </div>;
}

export function TaxonomyCollections({ data }: { data: CollectionWorkspaceData }) {
  const router = useRouter();
  const operation = useTaxonomyOperation();
  const setDirty = useTaxonomyDirty();
  const { current, owner, marketId, marketName, eligibleCount } = data;
  const [revision, setRevision] = useState<number | null>(current?.revision ?? null);
  const [published, setPublished] = useState(current?.published ?? false);
  const [members, setMembers] = useState(current?.products ?? []);
  const [savedIds, setSavedIds] = useState(current?.products.map(product => product.id) ?? []);
  const [feedback, setFeedback] = useState<"metadata" | "publication" | "membership">("metadata");
  const duplicateGuard = new Set(members.map(product => product.id));
  const savedSet = new Set(savedIds);
  const change = {
    added: members.filter(product => !savedSet.has(product.id)).length,
    removed: savedIds.filter(id => !duplicateGuard.has(id)).length,
    order: savedIds.some((id, index) => members[index]?.id !== id),
  };
  const membershipDirty = change.added > 0 || change.removed > 0 || change.order;
  const saveButton = operation.pending ? "Saving…" : "Save collection";

  function edit(next: CollectionProductOption[]) {
    setMembers(next);
    setDirty(next.length !== savedIds.length || next.some((item, index) => item.id !== savedIds[index]));
  }

  function move(index: number, offset: number) {
    const next = [...members];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    edit(next);
  }

  async function saveMetadata(event: FormEvent<HTMLFormElement>) {
    const values = new FormData(event.currentTarget);
    setFeedback("metadata");
    const value = (name: string) => String(values.get(name) ?? "");
    const id = current?.id ?? value("id");
    const saved = await operation.run(async () => {
      const src = value("photo.src");
      const alt = value("photo.alt");
      const result = await runCatalogCommand<{ revision: number }>("collection.save", {
        id, expectedRevision: revision, name: value("name"), slug: value("slug"), description: value("description"),
        selection: value("selection"), position: Number(value("position")), image: src || alt ? { src, alt } : null,
      });
      setRevision(result.revision);
    }, current ? "Collection saved." : "Collection created.", { refresh: Boolean(current) });
    if (saved && !current) router.replace(collectionHref(id));
    return saved;
  }

  async function saveMembers() {
    if (!current || revision === null) return;
    setFeedback("membership");
    const productIds = members.map(product => product.id);
    const saved = await operation.run(async () => {
      const result = await runCatalogCommand<{ revision: number }>("collection.products", {
        collectionId: current.id, expectedRevision: revision, expectedProductIds: savedIds, productIds,
      });
      setRevision(result.revision);
    }, "Product assignments saved.");
    if (saved) {
      setSavedIds(productIds);
      setDirty(false);
    }
  }

  async function publish(next: boolean) {
    if (!current || revision === null) return;
    setFeedback("publication");
    await operation.run(async () => {
      const result = await runCatalogCommand<{ revision: number; published: boolean }>("collection.publish", {
        collectionId: current.id, marketId, expectedRevision: revision, published: next,
      });
      setRevision(result.revision);
      setPublished(result.published);
    }, next ? `Collection published in ${marketName}.` : `Collection hidden in ${marketName}.`);
  }

  return <div className="taxonomy-editorial-grid taxonomy-collection-layout">
    <section className="commerce-panel taxonomy-card taxonomy-editorial-sidebar" aria-labelledby="collection-choices">
      <h2 id="collection-choices">Collections</h2>
      {data.collections.length ? <ul className="taxonomy-editor-list taxonomy-collection-choices">
        {data.collections.map(row => <li key={row.id}>
          <Link className="text-link" href={collectionHref(row.id)} aria-current={row.id === current?.id ? "page" : undefined}>{row.name}</Link>
          {" · "}{selectionLabels[row.selection]}{" · "}{row.published ? "Published" : "Hidden"}
        </li>)}
      </ul> : <p className="taxonomy-muted">There are no collections yet.</p>}
      {owner && <Link className="button button--outline" href={collectionHref("new")}>New collection</Link>}
    </section>
    <div className="commerce-stack">
    {(current || owner) && <section className="commerce-panel taxonomy-card" aria-labelledby="collection-details">
      <h2 id="collection-details">{current ? current.name : "New collection"}</h2>
      {owner ? <TaxonomyForm onSubmit={saveMetadata}>
        <div className="commerce-fields">
          <label>Collection name<input name="name" required defaultValue={current?.name} minLength={2} maxLength={100} /></label>
          <label>Stable ID<input name="id" required defaultValue={current?.id} readOnly={Boolean(current)}
            maxLength={80} pattern="[a-z0-9][a-z0-9\-]{0,79}" /></label>
          <label>URL slug<input name="slug" required defaultValue={current?.slug} maxLength={120} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label>
          <label>Display order<input name="position" type="number" min={0} max={9999} required defaultValue={current?.position ?? 100} /></label>
        </div>
        <label>Description<textarea name="description" defaultValue={current?.description} rows={3} maxLength={1200} /></label>
        <label>Product selection<select name="selection" defaultValue={current?.selection ?? "CURATED"}>
          <option value="CURATED">Manual collection</option>
          <option value="NEW">New arrivals</option>
          <option value="FEATURED">Featured products</option>
        </select></label>
        <CatalogImageField name="photo" src={current?.imageSrc ?? undefined} alt={current?.imageAlt ?? undefined} />
        {current?.selection === "CURATED" && members.length > 0 && <p className="taxonomy-muted">Remove manual assignments before switching rules.</p>}
        <div className="taxonomy-actions"><button className="button button--primary" type="submit" disabled={operation.pending}>{saveButton}</button></div>
      </TaxonomyForm> : current && <p>{selectionLabels[current.selection]}. Central owners manage the shared details and products.</p>}
      {feedback === "metadata" && <TaxonomyFeedback {...operation} />}
    </section>}
    {current && <section className="commerce-panel taxonomy-card" aria-labelledby="collection-publication">
      <h2 id="collection-publication">{marketName} publication</h2>
      <p>{published ? "Published" : "Hidden"} · {eligibleCount} visible {eligibleCount === 1 ? "product" : "products"}</p>
      {!current.hasOverride && <p className="taxonomy-muted">Using the shared collection’s default visibility.</p>}
      {eligibleCount === 0 && !published && <p className="taxonomy-muted">A published collection needs a product with a visible offer in this market.</p>}
      {membershipDirty && <p className="taxonomy-muted">Save product changes before changing publication.</p>}
      <div className="taxonomy-actions">
        <button className="button button--outline" type="button"
          disabled={operation.pending || membershipDirty || (!published && !eligibleCount)}
          onClick={() => void publish(!published)}>{published ? "Hide in market" : "Publish in market"}</button>
        {published && <a className="text-link" href={current.previewHref}>View published collection</a>}
      </div>
      {feedback === "publication" && <TaxonomyFeedback {...operation} />}
    </section>}
    {current && owner && <section className="commerce-panel taxonomy-card" aria-labelledby="collection-products">
      <h2 id="collection-products">Products</h2>
      {current.selection === "CURATED" ? <>
        <p className="taxonomy-muted">{members.length} {members.length === 1 ? "product" : "products"} selected</p>
        {members.length > 0 && <div className="taxonomy-scroll">
          <table className="taxonomy-table">
            <thead><tr><th scope="col">Order</th><th scope="col">Product</th><th scope="col">Current market</th><th scope="col">Actions</th></tr></thead>
            <tbody>{members.map((product, index) => <tr key={product.id}>
              <td>{index + 1}</td><th scope="row">{product.name}</th><td>{product.visibleInMarket ? "Visible" : "Unavailable"}</td><td>
                <div className="taxonomy-actions">
                  <button className="button button--outline" type="button" aria-label={`Move ${product.name} up`}
                    disabled={operation.pending || index === 0} onClick={() => move(index, -1)}>Up</button>
                  <button className="button button--outline" type="button" aria-label={`Move ${product.name} down`}
                    disabled={operation.pending || index === members.length - 1} onClick={() => move(index, 1)}>Down</button>
                  <button className="button button--outline" type="button" aria-label={`Remove ${product.name}`}
                    disabled={operation.pending} onClick={() => edit(members.filter(item => item.id !== product.id))}>Remove</button>
                </div>
              </td>
            </tr>)}</tbody>
          </table>
        </div>}
        {membershipDirty && <p role="status">{change.added} to add · {change.removed} to remove{change.order ? " · order changed" : ""}</p>}
        <div className="taxonomy-actions"><button className="button button--primary" type="button"
          disabled={operation.pending || !membershipDirty} onClick={() => void saveMembers()}>Save product assignments</button></div>
        {feedback === "membership" && <TaxonomyFeedback {...operation} />}
        <ProductSearch marketId={marketId} collectionId={current.id} selected={duplicateGuard} disabled={operation.pending}
          onAdd={product => { if (!operation.pending && !duplicateGuard.has(product.id)) edit([...members, product]); }} />
      </> : <p>{current.selection === "NEW" ? "Shows products flagged as new arrivals." : "Shows products flagged as featured."}</p>}
    </section>}
    </div>
  </div>;
}

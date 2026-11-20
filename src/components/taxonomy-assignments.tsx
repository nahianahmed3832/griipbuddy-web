"use client";

import { useEffect, useId, useRef, useState } from "react";
import { departmentAncestorPath } from "../lib/catalog/departments";
import type { AssignmentCategory, CategoryAssignmentPage } from "../lib/staff/taxonomy-assignment-read";
import { runCatalogCommand, useTaxonomyDirty } from "./taxonomy-controls";
import { readTaxonomyData } from "./taxonomy-read";

type Product = CategoryAssignmentPage["products"][number];
type Scope = CategoryAssignmentPage["scope"];
const scopes = [
  ["direct", "Direct assignments"], ["descendants", "Descendant products"],
  ["all", "Whole branch"], ["search", "All catalog products"],
] as const;

function editableCategories(categories: readonly AssignmentCategory[]) {
  const byId = new Map(categories.map(category => [category.id, category]));
  return categories.flatMap(category => {
    if (category.kind !== "SUBCATEGORY") return [];
    const path = departmentAncestorPath(byId, category.id);
    return path?.length === 3 && path[0].kind === "DEPARTMENT" && path[1].kind === "CATEGORY" &&
      path.every(node => node.state === "ACTIVE") ?
      [{ id: category.id, label: path.map(node => node.name).join(" / ") }] : [];
  }).sort((a, b) => a.label.localeCompare(b.label));
}

function savePlacement(product: Product, primaryCategoryId: string, secondaryCategoryIds: string[]) {
  return runCatalogCommand("product.assignments", { productId: product.id, revision: product.revision, primaryCategoryId, secondaryCategoryIds });
}

function PlacementEditor({ product, options, originalCategory, onSaved, onCancel, onDirty }: {
  product: Product;
  options: ReturnType<typeof editableCategories>;
  originalCategory: string;
  onSaved: (message: string) => void;
  onCancel: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const heading = useId();
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const [primary, setPrimary] = useState(product.primaryCategoryId);
  const [additional, setAdditional] = useState(product.secondaryCategoryIds);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const optionsWithPrimary = options.some(option => option.id === product.primaryCategoryId)
    ? options : [{ id: product.primaryCategoryId, label: `${originalCategory} (current legacy placement)` }, ...options];
  const missing = product.secondaryCategoryIds.filter(id => !options.some(option => option.id === id));
  const isDirty = primary !== product.primaryCategoryId ||
    JSON.stringify([...additional].sort()) !== JSON.stringify([...product.secondaryCategoryIds].sort());
  const displayOptions = options.filter(option => option.id !== primary &&
    (additional.includes(option.id) || option.label.toLowerCase().includes(query.trim().toLowerCase())));
  useEffect(() => editorHeading.current?.focus(), []);
  return <section className="taxonomy-card" aria-labelledby={heading}>
    <h3 id={heading} ref={editorHeading} tabIndex={-1}>Edit {product.name} placements</h3>
    <form className="taxonomy-form" aria-label={`Edit assignments for ${product.name}`} onSubmit={async event => {
      event.preventDefault();
      setSaving(true); setError("");
      try {
        await savePlacement(product, primary, additional);
        onDirty(false);
        onSaved(`Saved category assignments for ${product.name}.`);
      } catch (error) {
        setError(error instanceof Error ? error.message : "Could not save this assignment.");
      } finally { setSaving(false); }
    }}>
      <label>Primary category
        <select value={primary} disabled={saving} onChange={event => {
          const next = event.currentTarget.value;
          setPrimary(next);
          setAdditional(current => current.filter(id => id !== next));
          onDirty(true);
        }}>
          {optionsWithPrimary.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </label>
      <p className="taxonomy-muted">The product keeps one primary category. Select any additional placements below.</p>
      <fieldset disabled={saving} className="taxonomy-form">
        <legend>Additional categories</legend>
        <label>Filter additional categories
          <input type="search" value={query} onChange={event => setQuery(event.currentTarget.value)} />
        </label>
        <div className="taxonomy-choice-list">
          {displayOptions.map(option => <label key={option.id}>
            <input type="checkbox" checked={additional.includes(option.id)} onChange={event => {
              const checked = event.currentTarget.checked;
              setAdditional(current => checked ? [...current, option.id] : current.filter(id => id !== option.id));
              onDirty(true);
            }} /> {option.label}
          </label>)}
          {missing.map(id => <label key={id}>
            <input type="checkbox" checked={additional.includes(id)} disabled={!additional.includes(id)} onChange={() => {
              setAdditional(current => current.filter(value => value !== id)); onDirty(true);
            }} /> {id} (unavailable placement)
          </label>)}
          {!displayOptions.length && !missing.length && <p className="taxonomy-muted">No matching additional categories.</p>}
        </div>
      </fieldset>
      {error && <p role="alert" className="taxonomy-error">{error}</p>}
      <div className="taxonomy-actions">
        <button type="submit" className="taxonomy-button taxonomy-button--primary" disabled={!isDirty || saving}>{saving ? "Saving…" : "Save assignments"}</button>
        <button type="button" className="taxonomy-button" disabled={saving} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  </section>;
}

export function TaxonomyAssignments({ categoryId, categoryName, categories, canEdit = true }: {
  categoryId: string;
  categoryName: string;
  categories: readonly AssignmentCategory[];
  canEdit?: boolean;
}) {
  const heading = useId();
  const setDirty = useTaxonomyDirty();
  const [scope, setScope] = useState<Scope>("all");
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{ request: string; data?: CategoryAssignmentPage; error?: string }>();
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<Product>();
  const [editorDirty, setEditorDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [summary, setSummary] = useState("");
  const [failures, setFailures] = useState<string[]>([]);
  const url = `assignments?${new URLSearchParams({ categoryId, scope, q: submitted, page: String(page) })}`;
  const request = `${url}&refresh=${reload}`;
  useEffect(() => {
    if (!canEdit) return;
    const controller = new AbortController();
    readTaxonomyData<CategoryAssignmentPage>(url, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setResult({ request, data });
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ request, error: error instanceof Error ? error.message : "Could not load assignments." });
    });
    return () => controller.abort();
  }, [request, url, canEdit]);

  if (!canEdit) return <section className="taxonomy-card" aria-labelledby={heading}>
    <h2 id={heading}>Product assignments</h2><p className="taxonomy-muted">A central owner manages shared category placements.</p>
  </section>;

  const data = result?.request === request ? result.data : undefined;
  const error = result?.request === request ? result.error : undefined;
  const positions = new Map(categories.map(category => [category.id, category.name]));
  const options = editableCategories(categories);
  const canAssignToCategory = options.some(option => option.id === categoryId);
  const isAddable = (product: Product) => product.primaryCategoryId !== categoryId && !product.secondaryCategoryIds.includes(categoryId);
  const eligible = canAssignToCategory ? data?.products.filter(isAddable) ?? [] : [];
  const selectedRows = eligible.filter(product => selected.includes(product.id));
  const selectedCount = selectedRows.length;
  const selectPage = selectedCount > 0 && selectedCount === eligible.length;

  function changePage(next: number) { setPage(next); setSelected([]); }
  function changeScope(next: Scope) { setScope(next); changePage(1); }
  function markDirty(dirty: boolean) { setEditorDirty(dirty); setDirty(dirty); }
  function changeEditor(product?: Product) {
    if (editorDirty && !window.confirm("Discard unsaved assignment edits?")) return;
    markDirty(false);
    setEditing(product);
  }

  async function addSelected() {
    if (!selectedCount) return;
    setSummary(""); setFailures([]); setPending(true);
    const failed: string[] = [];
    const errors: string[] = [];
    for (const product of selectedRows) {
      try {
        await savePlacement(product, product.primaryCategoryId, [...product.secondaryCategoryIds, categoryId]);
      } catch (error) {
        failed.push(product.id);
        errors.push(`${product.name} — ${error instanceof Error ? error.message : "Could not save."}`);
      }
    }
    setPending(false);
    setSelected(failed);
    setSummary(`Added ${selectedCount - failed.length} of ${selectedCount} selected products to ${categoryName} as an additional category.`);
    setFailures(errors);
    setReload(value => value + 1);
  }

  return <section className="taxonomy-card" aria-labelledby={heading}>
    <h2 id={heading}>Product assignments</h2>
    <p className="taxonomy-muted">Direct placements stay attached to this category when it moves. Descendant products belong to its child branches.</p>
    <form className="taxonomy-fields" aria-label="Search product assignments" onSubmit={event => {
      event.preventDefault(); setSubmitted(query.trim()); changePage(1);
    }}>
      <label>Search products<input type="search" value={query} onChange={event => setQuery(event.currentTarget.value)}
        placeholder="Name, brand, ID or SKU" maxLength={120} /></label>
      <label>Show<select value={scope} disabled={pending} onChange={event => changeScope(event.currentTarget.value as Scope)}>
        {scopes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <div className="taxonomy-actions"><button type="submit" className="taxonomy-button taxonomy-button--primary" disabled={pending}>Search</button></div>
    </form>
    {canAssignToCategory && <div className="taxonomy-actions">
      <button type="button" className="taxonomy-button" disabled={!selectedCount || pending} onClick={() => void addSelected()}>
        {pending ? "Saving assignments…" : "Add selected as additional"}
      </button>
      <span className="taxonomy-muted" aria-live="polite">{selectedCount} selected on this page</span>
    </div>}
    {summary && <p role="status" className="taxonomy-success">{summary}</p>}
    {!!failures.length && <div className="taxonomy-error" role="alert">
      <strong>{failures.length} {failures.length === 1 ? "assignment needs" : "assignments need"} attention.</strong>
      <ul>{failures.map(message => <li key={message}>{message}</li>)}</ul>
    </div>}
    {error ? <div className="taxonomy-error" role="alert">{error}
      <button type="button" className="taxonomy-button" onClick={() => setReload(value => value + 1)}>Retry</button>
    </div> : !data ? <p role="status">Loading product assignments…</p> : data.products.length ? <>
      <div className="taxonomy-scroll" role="region" aria-label="Product assignment results" tabIndex={0}>
        <table className="taxonomy-table">
          <caption className="taxonomy-muted">{data.total} products match the current view</caption>
          <thead><tr>
            {canAssignToCategory && <th scope="col">
              <input type="checkbox" aria-label="Select eligible products on this page" checked={selectPage} disabled={!eligible.length || pending}
                onChange={event => setSelected(event.currentTarget.checked ? eligible.map(product => product.id) : [])} />
            </th>}
            <th scope="col">Product</th><th scope="col">Placement</th><th scope="col">Primary category</th>
            <th scope="col">Status</th><th scope="col">Action</th>
          </tr></thead>
          <tbody>{data.products.map(product => <tr key={product.id}>
            {canAssignToCategory && <td><input type="checkbox" aria-label={`Select ${product.name}`}
              checked={selected.includes(product.id)} disabled={pending || !isAddable(product)} onChange={event => {
                const checked = event.currentTarget.checked;
                setSelected(current => checked ? [...current, product.id] : current.filter(id => id !== product.id));
              }} /></td>}
            <th scope="row">{product.name}</th>
            <td>{product.placement === "direct" ? product.primaryCategoryId === categoryId ? "Direct primary" : "Direct additional"
              : product.placement === "descendant" ? "Descendant" : "Outside this branch"}</td>
            <td>{positions.get(product.primaryCategoryId) ?? product.primaryCategoryId}</td>
            <td><span className="taxonomy-badge">{product.active && product.publication === "ACTIVE" ? "Published"
              : product.publication === "ARCHIVED" ? "Archived" : "Unpublished"}</span></td>
            <td><button type="button" className="taxonomy-button" disabled={pending} aria-label={`Edit assignments for ${product.name}`}
              onClick={() => changeEditor(product)}>Edit</button></td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className="taxonomy-actions">
        <button type="button" className="taxonomy-button" disabled={page === 1 || pending} onClick={() => changePage(page - 1)}>Previous page</button>
        <span className="taxonomy-muted">Page {page} of {data.pages}</span>
        <button type="button" className="taxonomy-button" disabled={page >= data.pages || pending} onClick={() => changePage(page + 1)}>Next page</button>
      </div>
    </> : <div>
      <p className="taxonomy-muted">No products match this view.</p>
      {page > 1 && <button type="button" className="taxonomy-button" onClick={() => changePage(1)}>Back to first page</button>}
    </div>}
    {editing && <PlacementEditor key={editing.id} product={editing} options={options}
      originalCategory={positions.get(editing.primaryCategoryId) ?? editing.primaryCategoryId}
      onDirty={markDirty} onCancel={() => changeEditor()} onSaved={message => {
        setSummary(message); setFailures([]); setEditing(undefined); setReload(value => value + 1);
      }} />}
  </section>;
}

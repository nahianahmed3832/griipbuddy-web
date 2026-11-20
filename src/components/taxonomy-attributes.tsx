"use client";

import { useEffect, useId, useState } from "react";
import type { CategoryAttributeImpact, CategoryAttributeWorkspace } from "../lib/staff/taxonomy-attribute-read";
import { runCatalogCommand, TaxonomyFeedback, TaxonomyForm, useConfirmTaxonomyNavigation, useTaxonomyDirty, useTaxonomyOperation } from "./taxonomy-controls";
import { readTaxonomyData } from "./taxonomy-read";

type Definition = CategoryAttributeWorkspace["definitions"][number];
type Rule = NonNullable<CategoryAttributeWorkspace["local"][number]>;
const types = [["TEXT", "Text"], ["NUMBER", "Number"], ["BOOLEAN", "True or false"], ["ENUM", "Allowed values"]] as const;
const reasons: Record<CategoryAttributeImpact["products"][number]["reasons"][number], string> = {
  required: "Required value missing", invalid_value: "Current value is invalid", not_applicable: "Stored value will no longer apply",
  use_variant_option: "Use the bound variant option",
};

function AttributeDefinitionForm({ definition, onSaved }: { definition?: Definition; onSaved: (message: string) => void }) {
  const operation = useTaxonomyOperation();
  const [scope, setScope] = useState<Definition["scope"]>(definition?.scope ?? "PRODUCT");
  const [dataType, setType] = useState<Definition["dataType"]>(definition?.dataType ?? "TEXT");
  const mayBind = scope === "VARIANT" && (dataType === "TEXT" || dataType === "ENUM");

  return <TaxonomyForm aria-label={definition ? `Edit ${definition.name} definition` : "Create reusable attribute"} onSubmit={async event => {
    const form = new FormData(event.currentTarget);
    const saved = await operation.run(() => runCatalogCommand("attribute.save", {
      id: definition?.id ?? String(form.get("id") ?? ""), name: String(form.get("name") ?? ""), scope, dataType,
      allowedValues: dataType === "ENUM" ? String(form.get("allowedValues") ?? "").split(/\r?\n/).map(value => value.trim()).filter(Boolean) : [],
      variantOptionKey: mayBind ? String(form.get("optionKey") ?? "").trim() || null : null,
    }), "Reusable attribute saved.", { refresh: false });
    if (saved) onSaved(definition ? "Reusable attribute updated." : "Reusable attribute created.");
    return saved;
  }}>
    <fieldset disabled={operation.pending} className="taxonomy-fields">
      <legend>{definition ? "Edit reusable definition" : "New reusable definition"}</legend>
      <label>Name<input name="name" required maxLength={100} defaultValue={definition?.name} /></label>
      <label>Stable ID<input name="id" required maxLength={80} pattern="[a-z0-9][a-z0-9-]{0,79}"
        defaultValue={definition?.id} readOnly={Boolean(definition)} /></label>
      <label>Scope<select value={scope} disabled={Boolean(definition)} onChange={event => setScope(event.currentTarget.value as Definition["scope"])}>
        <option value="PRODUCT">Product level</option><option value="VARIANT">Variant level</option>
      </select></label>
      <label>Data type<select value={dataType} disabled={Boolean(definition)}
        onChange={event => setType(event.currentTarget.value as Definition["dataType"])}>
        {types.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      {mayBind && <label>Existing variant option key<input name="optionKey" maxLength={40}
        defaultValue={definition?.variantOptionKey ?? ""} readOnly={Boolean(definition)} placeholder="For example, Color" /></label>}
    </fieldset>
    {dataType === "ENUM" && <label>Allowed values
      <textarea name="allowedValues" required rows={4} disabled={operation.pending} defaultValue={definition?.allowedValues.join("\n")} />
      <small className="taxonomy-muted">Enter one value per line. Introduce new values here. Removing an issued value first requires catalog reconciliation.</small>
    </label>}
    {definition && <p className="taxonomy-muted">The scope, type and option binding stay fixed after an attribute is created.</p>}
    <div className="taxonomy-actions"><button type="submit" className="taxonomy-button taxonomy-button--primary" disabled={operation.pending}>
      {operation.pending ? "Saving…" : "Save reusable attribute"}
    </button></div>
    <TaxonomyFeedback error={operation.error} message={operation.message} />
  </TaxonomyForm>;
}

function AttributeImpactPreview({ impact, pending, onPage }: { impact: CategoryAttributeImpact; pending: boolean; onPage: (page: number) => void }) {
  return <div className="taxonomy-impact">
    <p role="status">{impact.total ? `${impact.total} products need review, including ${impact.published} published.`
      : "This change introduces no new attribute issues in the branch."}</p>
    {!!impact.products.length && <>
      <div className="taxonomy-scroll" role="region" aria-label="Affected products" tabIndex={0}>
        <table className="taxonomy-table">
          <thead><tr><th scope="col">Affected product</th><th scope="col">Status</th><th scope="col">What needs review</th></tr></thead>
          <tbody>{impact.products.map(product => <tr key={product.id}>
            <th scope="row">{product.name}</th>
            <td>{product.isPublished ? "Published" : "Unpublished"}</td>
            <td>{product.reasons.map(reason => reasons[reason]).join(", ")}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {impact.pages > 1 && <div className="taxonomy-actions">
        <button type="button" className="taxonomy-button" onClick={() => onPage(impact.page - 1)} disabled={pending || impact.page === 1}>Previous affected products</button>
        <span>Page {impact.page} of {impact.pages}</span>
        <button type="button" className="taxonomy-button" onClick={() => onPage(impact.page + 1)} disabled={pending || impact.page >= impact.pages}>Next affected products</button>
      </div>}
    </>}
  </div>;
}

function AttributeTemplateForm({ workspace, attribute, onSaved }: {
  workspace: CategoryAttributeWorkspace;
  attribute: Definition;
  onSaved: (message: string) => void;
}) {
  const local = workspace.local.find(item => item.attributeId === attribute.id);
  const effective = workspace.effective.find(item => item.id === attribute.id);
  const rule = local ?? effective;
  const operation = useTaxonomyOperation();
  const [mode, setMode] = useState<"override" | "inherit" | "exclude">(local ? (local.excluded ? "exclude" : "override") : effective ? "inherit" : "override");
  const [required, setRequired] = useState(rule?.required ?? false);
  const [filterable, setFilterable] = useState(rule?.filterable ?? false);
  const [position, setPosition] = useState(String(rule?.position ?? 100));
  const [inheritable, setInheritable] = useState(rule?.inheritable ?? true);
  const [impact, setImpact] = useState<CategoryAttributeImpact>();
  const [reviewed, setReviewed] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const setDirty = useTaxonomyDirty();
  const template: Omit<Rule, "attributeId" | "departmentId"> | null = mode === "inherit" ? null : {
    position: Number(position), required: mode === "override" && required, filterable: mode === "override" && filterable,
    inheritable, excluded: mode === "exclude",
  };
  const input = { departmentId: workspace.category.id, attributeId: attribute.id, expectedRevision: workspace.category.revision, template };
  const derived = mode !== "inherit" ? /^\d{1,4}$/.test(position) : true;
  const changed = Boolean(local || template) && JSON.stringify(template) !== JSON.stringify(local && {
    position: local.position, required: local.required, filterable: local.filterable,
    inheritable: local.inheritable, excluded: local.excluded,
  });
  const disabled = operation.pending || previewing;
  function changedDraft() { setImpact(undefined); setReviewed(false); setPreviewError(""); setDirty(true); }

  async function preview(page = 1) {
    setPreviewError(""); setPreviewing(true);
    try {
      const report = await readTaxonomyData<CategoryAttributeImpact>(`attribute-impact?page=${page}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
      });
      setImpact(report);
    } catch (error) {
      setImpact(undefined);
      setPreviewError(error instanceof Error ? error.message : "Could not preview this template.");
    } finally { setPreviewing(false); }
  }

  return <form className="taxonomy-form" aria-label={`Template for ${attribute.name}`} onSubmit={async event => {
    event.preventDefault();
    if (!derived || !changed || disabled || !impact || (!!impact.total && !reviewed)) return;
    const success = await operation.run(() => runCatalogCommand("category.attribute", input), "Category template saved.");
    if (success) {
      setDirty(false);
      onSaved(impact.total ? `Template saved. ${impact.total} products still need attribute review.` : "Category template saved.");
    }
  }}>
    <p className="taxonomy-muted">{attribute.scope === "PRODUCT" ? "Product level" : "Variant level"} · {types.find(([value]) => value === attribute.dataType)?.[1]}
      {attribute.variantOptionKey && ` · Bound to ${attribute.variantOptionKey}`}</p>
    <fieldset className="taxonomy-fields" disabled={disabled}>
      <legend>Selected template</legend>
      <label>Template behavior<select value={mode} onChange={event => {
        setMode(event.currentTarget.value as typeof mode); changedDraft();
      }}>
        <option value="inherit">Use inherited rules</option>
        <option value="override">Set a rule for this category</option>
        <option value="exclude">Exclude this attribute</option>
      </select></label>
      {mode !== "inherit" && <>
        <label>Display order<input type="number" min={0} max={9999} required value={position}
          onChange={event => { setPosition(event.currentTarget.value); changedDraft(); }} /></label>
        {mode === "override" && <>
          <label className="taxonomy-check"><input type="checkbox" checked={required}
            onChange={event => { setRequired(event.currentTarget.checked); changedDraft(); }} /> Required</label>
          <label className="taxonomy-check"><input type="checkbox" checked={filterable}
            onChange={event => { setFilterable(event.currentTarget.checked); changedDraft(); }} /> Use as storefront filter</label>
        </>}
        <label className="taxonomy-check"><input type="checkbox" checked={inheritable}
          onChange={event => { setInheritable(event.currentTarget.checked); changedDraft(); }} /> Apply to descendants</label>
      </>}
    </fieldset>
    <p className="taxonomy-muted">The nearest applicable rule wins. Inheriting clears this category’s override. Excluding masks inherited rules in the selected scope. Saved product values are retained.</p>
    <div className="taxonomy-actions">
      <button type="button" className="taxonomy-button" onClick={() => void preview()} disabled={!changed || !derived || disabled}>
        {previewing ? "Checking products…" : "Preview affected products"}
      </button>
      <button type="submit" className="taxonomy-button taxonomy-button--primary" disabled={!changed || !derived || disabled || !impact || (!!impact.total && !reviewed)}>
        {operation.pending ? "Saving…" : "Save template"}
      </button>
    </div>
    <TaxonomyFeedback error={operation.error || previewError} />
    {impact && <>
      <AttributeImpactPreview impact={impact} pending={previewing} onPage={page => void preview(page)} />
      {!!impact.total && <label className="taxonomy-check"><input type="checkbox" checked={reviewed} disabled={disabled}
        onChange={event => setReviewed(event.currentTarget.checked)} /> I reviewed the impact and will reconcile affected product values.</label>}
    </>}
  </form>;
}

export function TaxonomyAttributes({ categoryId, categoryName, revision, canEdit = true, onSaved }: {
  categoryId: string;
  categoryName: string;
  revision: number;
  canEdit?: boolean;
  onSaved?: () => void;
}) {
  const heading = useId();
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{ request: string; data?: CategoryAttributeWorkspace; error?: string }>();
  const [attributeId, setAttributeId] = useState("");
  const [definitionId, setDefinitionId] = useState("");
  const [message, setMessage] = useState("");
  const confirmNavigation = useConfirmTaxonomyNavigation();
  const request = `${categoryId}:${revision}:${reload}`;
  useEffect(() => {
    if (!canEdit) return;
    const controller = new AbortController();
    readTaxonomyData<CategoryAttributeWorkspace>(`attribute-impact?${new URLSearchParams({ categoryId })}`,
      { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setResult({ request, data });
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ request, error: error instanceof Error ? error.message : "Could not load attributes." });
    });
    return () => controller.abort();
  }, [request, categoryId, canEdit]);
  const data = result?.request === request ? result.data : undefined;
  const error = result?.request === request ? result.error : undefined;
  const current = data?.definitions.find(item => item.id === attributeId);
  const definition = data?.definitions.find(item => item.id === definitionId);
  function saved(text: string) { setMessage(text); setReload(value => value + 1); onSaved?.(); }

  return <section className="taxonomy-card" aria-labelledby={heading}>
    <h2 id={heading}>Attributes</h2>
    <p className="taxonomy-muted">Templates apply to products whose primary placement is {categoryName} or an inheriting descendant.</p>
    {message && <p role="status" className="taxonomy-success">{message}</p>}
    {!canEdit ? <p>A central owner manages attribute definitions and category templates.</p> : error ?
      <div className="taxonomy-error" role="alert">{error}
        <button type="button" className="taxonomy-button" onClick={() => setReload(value => value + 1)}>Retry</button>
      </div> : !data ? <p role="status">Loading attribute templates…</p> : <>
      <div className="taxonomy-scroll" role="region" aria-label="Effective attributes" tabIndex={0}><table className="taxonomy-table">
        <thead><tr><th scope="col">Attribute</th><th scope="col">Scope</th><th scope="col">Origin</th><th scope="col">Rule</th><th scope="col">Order</th></tr></thead>
        <tbody>{data.effective.map(item => <tr key={item.id}>
          <th scope="row">{item.name}</th><td>{item.scope === "PRODUCT" ? "Product" : "Variant"}</td>
          <td>{item.sourceDepartmentId === categoryId ? "Local override"
            : `Inherited from ${data.inheritedSources.find(category => category.id === item.sourceDepartmentId)?.name ?? item.sourceDepartmentId}`}</td>
          <td>{item.required ? "Required" : "Optional"}{item.filterable && " · Filterable"}{item.inheritable && " · Descendants"}</td><td>{item.position}</td>
        </tr>)}
        {data.local.filter(item => item.excluded).map(item => <tr key={item.attributeId}>
          <th scope="row">{data.definitions.find(attribute => attribute.id === item.attributeId)?.name ?? item.attributeId}</th>
          <td>{data.definitions.find(attribute => attribute.id === item.attributeId)?.scope === "VARIANT" ? "Variant" : "Product"}</td>
          <td>Local exclusion</td><td>{item.inheritable ? "Excluded here and for descendants" : "Excluded here"}</td><td>{item.position}</td>
        </tr>)}
        {!data.effective.length && !data.local.some(item => item.excluded) && <tr><td colSpan={5}>No effective attributes for this category.</td></tr>}
        </tbody>
      </table></div>
      {!data.category.kind || data.category.state === "ARCHIVED" ? <p className="taxonomy-muted">Templates require a typed, editable category.</p> : <>
        <label>Choose a reusable attribute<select value={attributeId} onChange={event => {
          if (confirmNavigation()) setAttributeId(event.currentTarget.value);
        }}>
          <option value="">Select an attribute</option>
          {data.definitions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        {current && <AttributeTemplateForm key={`${categoryId}:${current.id}:${data.category.revision}`} workspace={data} attribute={current} onSaved={saved} />}
      </>}
      <details>
        <summary>Manage reusable attribute definitions</summary>
        <label>Definition<select value={definitionId} onChange={event => {
          if (confirmNavigation()) setDefinitionId(event.currentTarget.value);
        }}>
          <option value="">Create reusable attribute</option>
          {data.definitions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <AttributeDefinitionForm key={definitionId} definition={definition} onSaved={saved} />
      </details>
    </>}
  </section>;
}

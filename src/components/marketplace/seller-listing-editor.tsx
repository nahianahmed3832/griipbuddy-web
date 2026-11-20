"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useRef, useState, type ChangeEvent } from "react";
import type { Market } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import type { sellerListingReview } from "@/lib/marketplace/listing-review";
import type { SellerListingDraft } from "@/lib/marketplace/listing-review-input";
import { TaxonomyFeedback, useTaxonomyDirty, useTaxonomyOperation } from "@/components/taxonomy-controls";
import { SellerStatus } from "./seller-ui";
import { sellerListingStates } from "./seller-listing-state";
import {
  editListingVariants, saveListingVariants, SellerListingVariants, type ListingVariantEdit,
} from "./seller-listing-variants";

type DraftEdit = Omit<SellerListingDraft, "variants"> & { variants: ListingVariantEdit[] };
type SellerListingReview = NonNullable<Awaited<ReturnType<typeof sellerListingReview>>>;

const emptyDraft: SellerListingDraft = { name: "", description: "", departmentId: "", variants: [] };
const photoTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

async function catalogResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as {
    data?: T; message?: string; error?: { message?: string };
  } | null;
  if (!response.ok || !payload?.data) {
    throw new Error(payload?.error?.message ?? payload?.message ?? "The listing action could not be completed. Try again.");
  }
  return payload.data;
}

export function SellerListingEditor({ productId, review, seed, departments, market, canEdit, live, archived, sharedLocked }: {
  productId?: string;
  review?: SellerListingReview | null;
  seed?: SellerListingDraft;
  departments: readonly { id: string; name: string }[];
  market: Market;
  canEdit: boolean;
  live: boolean;
  archived?: boolean;
  sharedLocked: boolean;
}) {
  const router = useRouter();
  const operation = useTaxonomyOperation();
  const upload = useTaxonomyOperation();
  const markDirty = useTaxonomyDirty();
  const creationOperation = useRef<string | null>(null);
  const [confirmed, setConfirmed] = useState<SellerListingReview | null>(null);
  const [edit, setEdit] = useState<DraftEdit | null>(null);
  const [reviseSubmission, setReviseSubmission] = useState(false);
  const [feedbackArea, setFeedbackArea] = useState<"review" | "save">("review");
  const latest = confirmed && confirmed.revision >= (review?.revision ?? -1) ? confirmed : review;
  const base = latest?.draft ?? seed ?? emptyDraft;
  const draft = edit ?? { ...base, variants: editListingVariants(base.variants, market.minorDigits) };
  const currentStatus = latest ? sellerListingStates[latest.state] : null;
  const id = latest?.productId ?? productId;
  const editable = !archived && canEdit && (latest?.state !== "SUBMITTED" || reviseSubmission);
  const sharedEditable = editable && !sharedLocked;
  const publicVersion = live && latest?.state !== "WITHDRAWN";
  const busy = operation.pending || upload.pending;
  const replacesReviewedDraft = latest?.state === "APPROVED" || latest?.state === "PUBLISHED";

  function change(fields: Partial<DraftEdit>) {
    setEdit(previous => ({ ...(previous ?? draft), ...fields }));
    markDirty(true);
  }

  async function command(action: "save" | "submit" | "withdraw") {
    let saved: SellerListingReview | undefined;
    const success = { save: "Draft saved.", submit: "Listing submitted for review.", withdraw: "Listing withdrawn in this market." };
    setFeedbackArea(action === "save" ? "save" : "review");
    const ok = await operation.run(async () => {
      if (action === "save" && draft.image && !draft.image.alt.trim()) throw new Error("Enter a description for the listing photo.");
      const create = action === "save" && !id;
      if (create && !creationOperation.current) creationOperation.current = crypto.randomUUID();
      const response = await fetch(storefrontPath("/api/marketplace/seller/listings"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action, marketId: market.id, productId: id, revision: latest?.revision,
          ...(create && { operationId: creationOperation.current }),
          ...(action === "save" && { draft: {
            ...draft,
            variants: saveListingVariants(draft.variants, market.minorDigits),
          } }),
        }),
      });
      saved = await catalogResponse<SellerListingReview>(response);
    }, success[action], { refresh: false });
    if (!ok || !saved) return;
    setConfirmed(saved);
    setEdit(null);
    setReviseSubmission(false);
    markDirty(false);
    if (!id) router.replace(`/seller/listings/${saved.productId}?market=${market.id}`);
    else router.refresh();
  }

  async function uploadPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    await upload.run(async () => {
      if (!file.size || file.size > 4 * 1024 * 1024 || !photoTypes.has(file.type)) {
        throw new Error("Choose a JPEG, PNG or WebP photo up to 4 MB.");
      }
      const response = await fetch(storefrontPath(`/api/marketplace/seller/listings/media?marketId=${market.id}`), {
        method: "POST", headers: { "Content-Type": file.type }, body: file,
      });
      const { src } = await catalogResponse<{ src: string }>(response);
      change({ image: { src, alt: draft.image?.alt ?? "" } });
    }, "Photo uploaded. Save the draft to keep it.", { refresh: false });
  }

  function withdraw() {
    const message = publicVersion ? `Take this listing off sale in ${market.name}?` : `Withdraw this draft in ${market.name}?`;
    if (window.confirm(edit ? `${message} Unsaved edits will be discarded.` : message)) void command("withdraw");
  }

  function restoreSharedDetails() {
    if (!seed || !window.confirm("Use the published product details and variant combinations? Draft prices for those variants will be kept.")) return;
    const prices = new Map(draft.variants.flatMap(row => row.id ? [[row.id, row.price] as const] : []));
    change({ ...seed, variants: editListingVariants(seed.variants, market.minorDigits).map(row => ({
      ...row,
      price: row.id && prices.has(row.id) ? prices.get(row.id)! : row.price,
    })) });
  }

  return <>
    <section className="seller-panel seller-listing-review" aria-labelledby="listing-review-title">
      <div className="seller-panel-heading">
        <div><h2 id="listing-review-title">Publication and review</h2>
          <p className="seller-muted">{market.name} · {market.currency}</p></div>
        <SellerStatus tone={currentStatus?.tone ?? "muted"}>{currentStatus?.label ?? "New draft"}</SellerStatus>
      </div>
      {publicVersion && <p className="seller-listing-note">{canEdit
        ? latest?.state === "PUBLISHED" ? `This version is published in ${market.name}.`
          : "The previous version remains published in this market. Staff review and publish revisions separately."
        : "This market has a published offer. Selling requires current market approval."}</p>}
      {latest?.state === "APPROVED" && <p>Marketplace staff approved this revision. It takes effect when staff publish it.</p>}
      {latest?.state === "SUBMITTED" && <p>The submission is awaiting marketplace review.</p>}
      {latest?.feedback && <div className="seller-listing-note"><strong>Reviewer feedback</strong><p>{latest.feedback}</p></div>}
      {sharedLocked && <div className="seller-listing-note">
        <p>A published offer in another market keeps product details and variants fixed. You can edit prices for {market.name}.</p>
        {editable && latest && seed && <button className="seller-button" type="button" disabled={busy}
          onClick={restoreSharedDetails}>Use published product details</button>}
      </div>}
      {archived ? <p>This listing was archived.</p> : !canEdit && <p>Selling approval is required to edit this listing in {market.name}.</p>}
      {!archived && latest && <div className="seller-actions seller-review-actions">
        {canEdit && latest.state === "DRAFT" && <button className="seller-button seller-button-primary" type="button" disabled={busy || Boolean(edit)}
          onClick={() => void command("submit")}>Submit for review</button>}
        {canEdit && latest.state === "SUBMITTED" && !reviseSubmission && <button className="seller-button" type="button" disabled={busy}
          onClick={() => setReviseSubmission(true)}>Revise submission</button>}
        {latest.state !== "WITHDRAWN" && <button className="seller-button" type="button" disabled={busy} onClick={withdraw}>
          Withdraw {publicVersion ? "listing" : latest.state === "SUBMITTED" ? "submission" : "draft"}
        </button>}
      </div>}
      {latest?.state === "DRAFT" && edit && <p className="seller-muted">Save your edits before submitting for review.</p>}
      {feedbackArea === "review" && <TaxonomyFeedback {...operation}/>}
    </section>
    <form className="seller-listing-editor" onSubmit={event => {
      event.preventDefault();
      if (editable && !busy) void command("save");
    }}>
      <fieldset className="seller-editor-fieldset" disabled={!editable || busy}>
        <div className="seller-editor-basics">
          <section className="seller-panel" aria-labelledby="listing-info-title">
            <div className="seller-panel-heading"><h2 id="listing-info-title">Product information</h2></div>
            <div className="seller-editor-fields">
              <label>Listing title<input value={draft.name} minLength={2} maxLength={120} required readOnly={!sharedEditable}
                onChange={event => change({ name: event.target.value })}/></label>
              <label>Primary category<select value={draft.departmentId} required disabled={!sharedEditable}
                onChange={event => change({ departmentId: event.target.value })}>
                <option value="">Choose a category</option>
                {draft.departmentId && !departments.some(option => option.id === draft.departmentId) &&
                  <option value={draft.departmentId}>{draft.departmentId} · Unavailable category</option>}
                {departments.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
              </select></label>
              <label>Description<textarea value={draft.description} rows={5} maxLength={4000} readOnly={!sharedEditable}
                onChange={event => change({ description: event.target.value })}/></label>
            </div>
          </section>
          <section className="seller-panel seller-editor-media" aria-labelledby="listing-photo-title">
            <div className="seller-panel-heading"><h2 id="listing-photo-title">Primary photo</h2></div>
            <div className="seller-editor-fields">
              {draft.image ? <div className="seller-listing-image"><Image src={storefrontPath(draft.image.src)} alt={draft.image.alt}
                width={240} height={180} unoptimized/></div>
                : <div className="seller-empty"><strong>No photo yet</strong><p>Add a listing photo before review.</p></div>}
              {sharedEditable && <label>{draft.image ? "Replace photo" : "Upload photo"}
                <input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => void uploadPhoto(event)}/>
              </label>}
              {draft.image && <label>Photo description<input value={draft.image.alt} maxLength={180} readOnly={!sharedEditable}
                onChange={event => draft.image && change({ image: { ...draft.image, alt: event.target.value } })}/></label>}
              {sharedEditable && draft.image && <div><button className="seller-button" type="button" onClick={() => change({ image: null })}>Remove photo</button></div>}
              {upload.pending && <p role="status">Uploading photo…</p>}
              <TaxonomyFeedback {...upload}/>
            </div>
          </section>
        </div>
        <SellerListingVariants variants={draft.variants} change={variants => change({ variants })} allowEditing={editable}
          allowSharedEditing={sharedEditable} currency={market.currency} minorDigits={market.minorDigits}/>
      </fieldset>
      {editable && <section className="seller-panel seller-listing-save">
        <div className="seller-actions">
          <button className="seller-button seller-button-primary" type="submit" disabled={busy}>
            {operation.pending ? "Working…" : replacesReviewedDraft ? "Save as new draft" : latest ? "Save draft" : "Create draft"}
          </button>
          {edit && <button className="seller-button" type="button" onClick={() => {
            if (!window.confirm("Discard unsaved listing edits?")) return;
            setEdit(null);
            markDirty(false);
          }}>Discard edits</button>}
        </div>
        {replacesReviewedDraft && <span className="seller-muted">Saving changes starts a new revision for review.</span>}
        {edit && <span className="seller-muted" role="status">Unsaved listing changes</span>}
        {feedbackArea === "save" && <TaxonomyFeedback {...operation}/>}
      </section>}
    </form>
  </>;
}

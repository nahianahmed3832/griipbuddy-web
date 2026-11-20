"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { MarketId } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";

type Preview = { issues: { row: number; message: string }[]; entries: { row: number; sku: string; units: number; replay: boolean }[]; token?: string };
type Outcome = { results: { row: number; status: string; message?: string }[] };

export function SellerStockImportForm({ marketId }: { marketId: MarketId }) {
  const endpoint = storefrontPath(`/api/marketplace/seller/inventory-import?market=${marketId}`);
  const router = useRouter();
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<Preview>();
  const [outcome, setOutcome] = useState<Outcome>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function process(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || pending) return;
    setPending(true);
    setError("");
    try {
      if (file.size > 131072) throw new Error("Choose a CSV up to 128 KB.");
      const response = await fetch(endpoint, { method: "POST", body: file, headers: { "Content-Type": "text/csv",
        ...(preview?.token && { "X-Inventory-Confirmation": preview.token }) } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "The file could not be processed.");
      if (preview?.token) { setOutcome(result); setPreview(undefined); router.refresh(); }
      else { setPreview(result); setOutcome(undefined); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The file could not be processed."); }
    finally { setPending(false); }
  }

  return <details className="seller-panel">
    <summary>Bulk stock adjustments</summary>
    <p className="seller-muted">Use one row per pool. Copy IDs and timestamps from the stock export. Set a unique operation key and a signed unit change. Preview before posting.</p>
    <a className="seller-button" href={endpoint} download>Download adjustment template</a>
    <form className="seller-filters" onSubmit={process} aria-label="Stock adjustment CSV">
      <label>Adjustment CSV<input type="file" accept=".csv,text/csv" required disabled={pending} onChange={event => {
        setFile(event.target.files?.[0]); setPreview(undefined); setOutcome(undefined); setError("");
      }}/></label>
      <button className="seller-button seller-button-primary" type="submit" disabled={pending || !file}>
        {pending ? "Working…" : preview?.token ? "Post reviewed adjustments" : "Preview adjustments"}</button>
    </form>
    {error && <p className="seller-field-error" role="alert">{error}</p>}
    {preview && <div aria-live="polite"><h3>Preview results</h3>
      {preview.issues.length > 0 && <ul className="seller-field-error" role="alert">{preview.issues.map((issue, index) =>
        <li key={index}>Row {issue.row} · {issue.message}</li>)}</ul>}
      <ul>{preview.entries.map(row => <li key={row.row}>Row {row.row} · {row.sku} · {row.units} units · {row.replay ? "Already posted" : "Ready to post"}</li>)}</ul>
    </div>}
    {outcome && <div aria-live="polite"><h3>Adjustment results</h3><ul>{outcome.results.map(row =>
      <li key={row.row}>Row {row.row} · {row.status}{row.message && ` · ${row.message}`}</li>)}</ul></div>}
  </details>;
}

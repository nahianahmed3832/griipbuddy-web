"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import type { MarketId } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";

type Preview = { issues: { row: number; message: string }[]; entries: { key: string; name: string; rows: number[] }[]; token?: string };
type Results = { results: { key: string; rows: number[]; status: string; message?: string; productId?: string }[] };

export function SellerListingImportForm({ marketId }: { marketId: MarketId }) {
  const endpoint = storefrontPath(`/api/marketplace/seller/listing-import?market=${marketId}`);
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<Preview>();
  const [results, setResults] = useState<Results>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || pending) return;
    setPending(true);
    setError("");
    try {
      if (file.size > 131072) throw new Error("Choose a CSV up to 128 KB.");
      const token = preview?.token;
      const response = await fetch(endpoint, { method: "POST", body: file, headers: { "Content-Type": "text/csv",
        ...(token && { "X-Import-Confirmation": token }) } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? "The file could not be processed.");
      if (token) { setResults(data as Results); setPreview(undefined); }
      else { setPreview(data as Preview); setResults(undefined); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Try again."); }
    finally { setPending(false); }
  }

  return <>
    <div className="seller-panel-heading"><div><h2>Listing CSV</h2><p className="seller-muted">Import one row per variant. Each listing key creates one draft. Add photos in the draft editor before submitting.</p></div>
      <a className="seller-button" href={endpoint} download>Download template</a></div>
    <form onSubmit={submit} className="seller-filters" aria-label="Preview or import a listing file">
      <label>CSV file<input type="file" accept=".csv,text/csv" disabled={pending} required onChange={event => {
        setFile(event.target.files?.[0]); setPreview(undefined); setResults(undefined); setError("");
      }}/></label>
      <button type="submit" className="seller-button seller-button-primary" disabled={!file || pending}>
        {pending ? "Working…" : preview?.token ? "Import reviewed file" : "Preview file"}
      </button>
    </form>
    {error && <p className="seller-field-error" role="alert">{error}</p>}
    {preview && <div aria-live="polite"><h3>Preview results</h3>
      {preview.issues.length > 0 && <ul className="seller-field-error" role="alert">{preview.issues.map((issue, index) =>
        <li key={index}>Row {issue.row} · {issue.message}</li>)}</ul>}
      <ul>{preview.entries.map(row => <li key={row.key}>{row.name} · Rows {row.rows.join(", ")}</li>)}</ul>
    </div>}
    {results && <div aria-live="polite"><h3>Import results</h3><ul>{results.results.map(row => <li key={row.key}>
      {row.productId ? <Link href={`/seller/listings/${row.productId}?market=${marketId}`}>{row.key}</Link> : row.key} · {row.status}
      {row.message && ` · ${row.message}`}
    </li>)}</ul></div>}
  </>;
}

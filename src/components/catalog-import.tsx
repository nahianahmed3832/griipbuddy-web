"use client";

import { storefrontPath } from "@/config/storefront-path";

import { useState, type FormEvent } from "react";
import type { ImportPreview, ImportResult } from "@/lib/staff/catalog-import";

export function CatalogImport() {
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<ImportPreview>();
  const [results, setResults] = useState<ImportResult[]>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function send(apply: boolean) {
    if (!file || pending || (apply && !preview?.token)) return;
    setPending(true);
    setError("");
    setResults(undefined);
    if (!apply) setPreview(undefined);
    try {
      const headers = new Headers({ "Content-Type": "text/csv" });
      if (apply) headers.set("X-Import-Confirmation", preview!.token!);
      const response = await fetch(storefrontPath("/api/staff/catalog-import"), { method: "POST", headers, body: file });
      const data: { preview?: ImportPreview; results?: ImportResult[]; message?: string } = await response.json();
      if (!response.ok) throw new Error(data.message ?? "The import request failed.");
      setPreview(data.preview);
      setResults(data.results);
    } catch (error) {
      setPreview(undefined);
      setError(error instanceof Error ? error.message : "The import request failed.");
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send(false);
  }

  return (
    <div className="catalog-editor commerce-stack">
      <form className="commerce-panel commerce-form" onSubmit={submit}>
        <label>Catalog CSV<input type="file" accept=".csv,text/csv" required disabled={pending} onChange={(event) => {
          setFile(event.target.files?.[0]);
          setPreview(undefined);
          setResults(undefined);
          setError("");
        }} /></label>
        <button className="button button--outline" type="submit" disabled={pending || !file}>Preview import</button>
      </form>
      {pending && <p role="status">Reading the catalog…</p>}
      {error && <p className="commerce-message commerce-message--error" role="alert">{error}</p>}
      {preview && <section className="commerce-panel">
        <h2>Import preview</h2>
        {preview.issues.length > 0 && <div className="commerce-message commerce-message--error" role="alert">
          <p>Fix these rows before applying the import.</p>
          <ul>{preview.issues.map(({ row, message }, index) => <li key={index}>Row {row} · {message}</li>)}</ul>
        </div>}
        <ul className="catalog-import-results">
          {preview.entries.map((entry) => <li key={entry.id}>
            <strong>{entry.status} · {entry.name}</strong>
            <p>Rows {entry.rows.join(", ")} · {entry.id} · {entry.skus.join(", ")}</p>
          </li>)}
        </ul>
        {preview.token && <button className="button button--primary" type="button" disabled={pending} onClick={() => void send(true)}>Apply import</button>}
      </section>}
      {results && <section className="commerce-panel" aria-live="polite">
        <h2>Import results</h2>
        <p>{results.filter(({ status }) => status === "New" || status === "Update").length} saved · {results.filter(({ status }) => status === "Unchanged").length} unchanged · {results.filter(({ status }) => status === "Failed").length} failed</p>
        <ul className="catalog-import-results">{results.map(({ id, status, message }) => <li key={id}>{status} · {id}{message && ` · ${message}`}</li>)}</ul>
      </section>}
    </div>
  );
}

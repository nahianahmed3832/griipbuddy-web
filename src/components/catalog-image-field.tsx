"use client";

import { storefrontPath } from "@/config/storefront-path";

import { useRef, useState } from "react";

export function CatalogImageField({ name, src, alt, required, label = "Image", allowUpload = true }: {
  name: string; src?: string; alt?: string; required?: boolean; label?: string; allowUpload?: boolean;
}) {
  const path = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);

  async function upload(file?: File) {
    if (!file) return;
    setBusy(true);
    setMessage("");
    setError(false);
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error("Choose an image up to 4 MB.");
      const response = await fetch(storefrontPath("/api/staff/catalog-image"), {
        method: "POST", headers: { "Content-Type": file.type }, body: file,
      });
      const data: { src?: string; message?: string } = await response.json();
      if (!response.ok || !data.src) throw new Error(data.message ?? "The image could not be uploaded.");
      if (path.current) path.current.value = data.src;
      setMessage("Image uploaded. Save the form to use it.");
    } catch (error) {
      setError(true);
      setMessage(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="catalog-image-field">
      {allowUpload && <label>{label} file<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={(event) => void upload(event.target.files?.[0])} /></label>}
      <label>{label} path<input ref={path} name={`${name}.src`} defaultValue={src} maxLength={100} required={required} placeholder="/media/…" /></label>
      <label>{label === "Image" ? "Alternative text" : `${label} alternative text`}<input name={`${name}.alt`} defaultValue={alt} maxLength={180} required={required} /></label>
      {busy && <p role="status">Uploading image…</p>}
      {message && <p role={error ? "alert" : "status"}>{message}</p>}
    </div>
  );
}

"use client";

import { useState } from "react";
import { storefrontPath } from "@/config/storefront-path";
import { videoUploadLimit } from "@/lib/catalog/video";

export function CatalogVideoField({ name, original }: { name: string; original?: string | null }) {
  const [src, setSrc] = useState(original ?? "");
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>();

  async function upload(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file) return;
    setUploading(true);
    setMessage(undefined);
    input.setCustomValidity("Wait for the video upload to finish before saving.");
    try {
      if (!file.size || file.size > videoUploadLimit) throw new Error("Choose an MP4 video up to 4 MB.");
      const response = await fetch(storefrontPath("/api/staff/catalog-video"), {
        method: "POST", headers: { "Content-Type": file.type }, body: file,
      });
      const data: { src?: string; message?: string } = await response.json().catch(() => ({}));
      if (!response.ok || !data.src) throw new Error(data.message ?? "The video could not be uploaded.");
      setSrc(data.src);
      setMessage({ text: "Video uploaded. Save the form to use it." });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "Upload failed.", error: true });
    } finally {
      input.value = "";
      input.setCustomValidity("");
      setUploading(false);
    }
  }

  return <div className="commerce-form">
    <input type="hidden" name={name} value={src} />
    {src && <video key={src} src={storefrontPath(src)} controls playsInline preload="none" width={240} aria-label="Catalog video preview" />}
    <label>{src ? "Replace video" : "Video file"}
      <input type="file" accept="video/mp4,.mp4" onChange={event => {
        if (!uploading) void upload(event.currentTarget);
      }} />
    </label>
    <small>Use an MP4 up to 4 MB. H.264 works across the widest range of devices.</small>
    {src && <button type="button" className="link-button" disabled={uploading} onClick={() => {
      setSrc("");
      setMessage({ text: "Save the form to remove the video." });
    }}>Remove video</button>}
    {uploading && <p role="status">Uploading video…</p>}
    {message && <p role={message.error ? "alert" : "status"}>{message.text}</p>}
  </div>;
}

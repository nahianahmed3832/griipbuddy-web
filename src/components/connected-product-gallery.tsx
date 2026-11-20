"use client";

import Image from "next/image";
import { ImageOff } from "lucide-react";
import { useRef, useState } from "react";
import { storefrontPath } from "@/config/storefront-path";
import type { CatalogVariant } from "@/lib/catalog/browser-catalog";

type Photo = NonNullable<CatalogVariant["image"]>;

function GalleryFrame({ photo }: { photo: Photo }) {
  const frame = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  return <div className="product-gallery__main" ref={frame} tabIndex={-1}>
    {failed ? <div className="connected-gallery-placeholder">
      <ImageOff aria-hidden="true" size={26} />
      <p role="status">This image couldn’t be loaded.</p>
      <button className="button button--outline" type="button" onClick={() => {
        frame.current?.focus({ preventScroll: true });
        setFailed(false);
      }}>Retry image</button>
    </div> : <Image src={storefrontPath(photo.src)} alt={photo.alt} fill loading="eager"
      sizes="(max-width: 700px) calc(100vw - 32px), (max-width: 1200px) 48vw, 600px"
      unoptimized={photo.src.startsWith("/media/")} onError={() => setFailed(true)} />}
  </div>;
}

export function ConnectedProductGallery({ sharedImages, variant }: {
  sharedImages: readonly Photo[]; variant?: Pick<CatalogVariant, "image" | "gallery">;
}) {
  const [picked, pick] = useState<string>();
  const photos = new Map<string, Photo>();
  for (const photo of [variant?.image, ...(variant?.gallery ?? []), ...sharedImages]) {
    if (photo && !photos.has(photo.src)) photos.set(photo.src, photo);
  }
  const current = (picked && photos.get(picked)) || photos.values().next().value;
  return <section className="product-gallery connected-gallery" aria-label="Product images">
    {current ? <GalleryFrame key={current.src} photo={current} /> : <div className="product-gallery__main">
      <div className="connected-gallery-placeholder">
        <ImageOff aria-hidden="true" size={26} />
        <p>No product image is available.</p>
      </div>
    </div>}
    {photos.size > 1 && <div className="product-gallery__thumbs" role="group" aria-label="Choose product image">
      {[...photos.values()].map((photo, index) => <button type="button" key={photo.src} aria-pressed={current?.src === photo.src}
        aria-label={`View image ${index + 1}: ${photo.alt}`} onClick={() => pick(photo.src)}>
        <Image src={storefrontPath(photo.src)} alt="" fill sizes="68px" unoptimized={photo.src.startsWith("/media/")} />
      </button>)}
    </div>}
  </section>;
}

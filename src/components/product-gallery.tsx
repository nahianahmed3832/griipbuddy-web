"use client";

import { ArrowLeft, ArrowRight, Play, X, ZoomIn } from "lucide-react";
import Image from "next/image";
import { useRef, useState } from "react";
import { storefrontPath } from "@/config/storefront-path";
import type { CatalogProduct, ListedVariant } from "@/lib/catalog/types";
import { CatalogPhoto } from "./catalog-photo";
import { FavoriteButton } from "./marketplace/favorites";
import "./product-gallery.css";

function variantColor(variant: ListedVariant) {
  return Object.entries(variant.options).find(([name]) => name.toLowerCase() === "color")?.[1].trim().toLowerCase();
}

export function ProductGallery({ product, selected, responsive, marketplace }: {
  product: CatalogProduct;
  selected: ListedVariant;
  responsive?: boolean;
  marketplace?: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [videoFailed, setVideoFailed] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const zoom = useRef<HTMLDialogElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const photos = [
    ...(selected.image ? [selected.image] : []),
    ...product.images,
    ...product.variants.flatMap((variant) => variant.image ? [variant.image] : []),
  ].filter((image, position, all) => all.findIndex((item) => item.src === image.src) === position);
  const color = variantColor(selected);
  const colorVideo = color ? product.variants.find((variant) => variant.videoUrl && variantColor(variant) === color)?.videoUrl : undefined;
  const video = videoFailed ? undefined : selected.videoUrl ?? colorVideo ?? product.videoUrl;
  const photoOffset = video ? 1 : 0;
  const count = photos.length + photoOffset;
  const showingVideo = Boolean(video && index === 0);
  const photo = photos[index - photoOffset];
  const move = (step: number) => setIndex(current => (current + count + step) % count);
  const moveZoom = (step: number) => setIndex(current =>
    photoOffset + (current - photoOffset + photos.length + step) % photos.length);

  if (!count) return null;
  return (
    <section className="product-gallery" aria-label="Product media">
      <div className="product-gallery__main"
        onTouchStart={event => {
          const touch = event.touches[0];
          touchStart.current = count > 1 && event.touches.length === 1 && touch
            ? { x: touch.clientX, y: touch.clientY } : null;
        }}
        onTouchEnd={event => {
          const start = touchStart.current;
          touchStart.current = null;
          const touch = event.changedTouches[0];
          if (!start || !touch || event.touches.length) return;
          const delta = touch.clientX - start.x;
          if (Math.abs(delta) >= 40 && Math.abs(delta) > Math.abs(touch.clientY - start.y) * 1.5) {
            event.preventDefault();
            move(delta < 0 ? 1 : -1);
          }
        }}
        onTouchCancel={() => { touchStart.current = null; }}>
        {video && showingVideo && <video src={storefrontPath(video)} poster={photos[0] && storefrontPath(photos[0].src)}
          className="product-gallery__video" aria-label={`Product video for ${product.name}`} controls playsInline preload="metadata"
          onError={() => { setVideoFailed(true); setIndex(0); }} />}
        {photo && <CatalogPhoto image={photo} responsive={responsive} rendition="detail" fill loading="eager" fetchPriority="high"
          sizes="(max-width: 759px) calc(100vw - 2rem), (max-width: 1250px) 47vw, 600px" />}
        {marketplace && photo && <button className="product-gallery__zoom" type="button" aria-label="Zoom product image"
          onClick={() => {
            zoom.current?.showModal();
            setZoomOpen(true);
          }}>
          <span><ZoomIn aria-hidden="true" size={20}/></span>
        </button>}
        {marketplace && <FavoriteButton product={product.id} name={product.name}/>}
        {count > 1 && <div className={`product-gallery__pagination${showingVideo ? " product-gallery__pagination--video" : ""}`}>
          <button type="button" aria-label="Previous product media" onClick={() => move(-1)}><ArrowLeft aria-hidden="true" size={16}/></button>
          <span aria-live="polite" aria-atomic="true">{index + 1} / {count}</span>
          <button type="button" aria-label="Next product media" onClick={() => move(1)}><ArrowRight aria-hidden="true" size={16}/></button>
        </div>}
      </div>
      {count > 1 && <div className="product-gallery__thumbs" role="group" aria-label="Choose product media">
        {video && <button type="button" aria-label="View product video" aria-pressed={showingVideo} onClick={() => setIndex(0)}>
          <Play size={19} aria-hidden="true"/>
        </button>}
        {photos.map((image, photoIndex) => <button key={image.src} type="button" aria-label={`View image ${photoIndex + 1}: ${image.alt}`}
          aria-pressed={index === photoIndex + photoOffset} onClick={() => setIndex(photoIndex + photoOffset)}>
          <CatalogPhoto image={{ ...image, alt: "" }} responsive={responsive} rendition="thumbnail" fill sizes="76px" fetchPriority="low"/>
        </button>)}
      </div>}
      {marketplace && <dialog className="store-dialog mp-image-zoom" ref={zoom} aria-label="Product image viewer"
        onClose={() => setZoomOpen(false)} onKeyDown={event => {
          if (event.key === "ArrowLeft") moveZoom(-1);
          if (event.key === "ArrowRight") moveZoom(1);
        }}>
        <button className="store-dialog__close" type="button" aria-label="Close image viewer" onClick={() => zoom.current?.close()}><X size={22}/></button>
        <div className="mp-zoom-frame">{zoomOpen && photo && <Image src={storefrontPath(photo.src)} alt={photo.alt} fill loading="eager" sizes="90vw"/>}</div>
        {photos.length > 1 && <div className="mp-gallery-controls">
          <button type="button" className="mp-icon" aria-label="Previous image" onClick={() => moveZoom(-1)}><ArrowLeft size={19}/></button>
          <span aria-live="polite">{index - photoOffset + 1} / {photos.length}</span>
          <button type="button" className="mp-icon" aria-label="Next image" onClick={() => moveZoom(1)}><ArrowRight size={19}/></button>
        </div>}
      </dialog>}
    </section>
  );
}

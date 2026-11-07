'use client';

import { useState } from 'react';
import type { CatalogProduct } from './catalog';

export function ProductVideos({ videos }: { videos: NonNullable<CatalogProduct['videos']> }) {
  const [open, setOpen] = useState(false);
  return <details className="detail-accordion product-videos" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Product videos</summary>
    {open && <div className="product-video-grid">
      {videos.map(({ url, title }, index) => {
        const label = title || 'Product video ' + (index + 1);
        return <figure key={url}>
          <video src={url} controls playsInline preload="none" aria-label={label} />
          <figcaption>{label}</figcaption>
        </figure>;
      })}
    </div>}
  </details>;
}

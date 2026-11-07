'use client';

import { ImageIcon } from 'lucide-react';
import Image, { type ImageProps } from 'next/image';
import { useState } from 'react';

export function CatalogImage({ src, alt, ...props }: Omit<ImageProps, 'src'> & { src?: string }) {
  const [failure, setFailure] = useState<{ src: string; fallback: 'original' | 'placeholder' }>();
  if (!src || (failure?.src === src && failure.fallback === 'placeholder')) {
    return <span className="catalog-image-empty"><ImageIcon aria-hidden size={24} /><span>Image unavailable</span></span>;
  }

  const external = src.startsWith('https://');
  const unoptimized = external && (
    !src.startsWith('https://d11ml80zmgyrxk.cloudfront.net/uploads/') || failure?.src === src
  );
  return <Image {...props} src={src} alt={alt} referrerPolicy="no-referrer" unoptimized={unoptimized}
    onError={() => setFailure({ src, fallback: external && !unoptimized ? 'original' : 'placeholder' })} />;
}

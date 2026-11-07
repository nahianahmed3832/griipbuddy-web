'use client';

import { ImageIcon } from 'lucide-react';
import Image, { type ImageProps } from 'next/image';
import { useState } from 'react';

export function CatalogImage({ src, alt, ...props }: Omit<ImageProps, 'src'> & { src?: string }) {
  const [failed, setFailed] = useState<string>();
  return src && failed !== src
    ? <Image {...props} src={src} alt={alt} referrerPolicy="no-referrer"
      unoptimized={src.startsWith('https://') && !src.startsWith('https://d11ml80zmgyrxk.cloudfront.net/uploads/')}
      onError={() => setFailed(src)} />
    : <span className="catalog-image-empty"><ImageIcon aria-hidden size={24} /><span>Image unavailable</span></span>;
}

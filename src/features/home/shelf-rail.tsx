'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useId, useRef, type ReactNode } from 'react';

export function ShelfRail({ label, heading, children }: { label: string; heading: ReactNode; children: ReactNode }) {
  const id = useId();
  const rail = useRef<HTMLDivElement>(null);

  function scroll(direction: number) {
    const element = rail.current;
    if (!element) return;
    element.scrollBy({
      left: direction * element.clientWidth,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    });
  }

  return <div className="shelf-rail">
    <div className="shelf-rail-header">{heading}<div className="shelf-rail-controls">
      <button type="button" className="icon-button" aria-controls={id} aria-label={'Previous ' + label} onClick={() => scroll(-1)}>
        <ChevronLeft aria-hidden />
      </button>
      <button type="button" className="icon-button" aria-controls={id} aria-label={'Next ' + label} onClick={() => scroll(1)}>
        <ChevronRight aria-hidden />
      </button>
    </div></div>
    <div className="shelf-rail-track" id={id} ref={rail}>{children}</div>
  </div>;
}

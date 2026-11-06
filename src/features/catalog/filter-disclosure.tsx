'use client';

import { useEffect, useRef, type ReactNode } from 'react';

export function FilterDisclosure({ applied, children }: { applied: number; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 761px)');
    function update() {
      if (ref.current) ref.current.open = wide.matches;
    }
    update();
    wide.addEventListener('change', update);
    return () => wide.removeEventListener('change', update);
  }, []);

  return <details ref={ref} className="catalog-filter-panel" open>
    <summary>Filters{applied > 0 && <span> · {applied} applied</span>}</summary>
    {children}
  </details>;
}

'use client';

import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PanelDialog } from '@/features/shell/panel-dialog';

export function FilterDisclosure({ applied, children }: { applied: number; children: ReactNode }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const wide = window.matchMedia('(min-width: 761px)');
    const dismiss = () => { if (wide.matches) setOpen(false); };
    wide.addEventListener('change', dismiss);
    return () => wide.removeEventListener('change', dismiss);
  }, []);

  const label = <>Filters{applied > 0 && <span> · {applied} applied</span>}</>;
  return <div className="catalog-filter-panel">
    <button type="button" aria-haspopup="dialog" className="button button-outline filter-trigger" ref={trigger} onClick={() => setOpen(true)}>
      <SlidersHorizontal size={16} aria-hidden />{label}
    </button>
    {open ? <PanelDialog title="Filters" placement="bottom" close={() => {
      setOpen(false);
      requestAnimationFrame(() => trigger.current?.focus());
    }}>{children}</PanelDialog> : <div className="desktop-filter">
      <h2>{label}</h2>{children}
    </div>}
  </div>;
}

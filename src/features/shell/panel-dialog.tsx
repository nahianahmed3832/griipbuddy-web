'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

export function PanelDialog({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-first-focus]')?.focus();
    return () => { if (dialog.open) dialog.close(); };
  }, []);

  return (
    <dialog ref={ref} className="drawer" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); close(); }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="drawer-inner">
        <div className="drawer-heading">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-button" aria-label={'Close ' + title.toLowerCase()} onClick={close}><X aria-hidden /></button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

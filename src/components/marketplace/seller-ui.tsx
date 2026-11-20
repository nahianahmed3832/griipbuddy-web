import Link from "next/link";
import type { ReactNode } from "react";

export function SellerPageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return <header className="seller-page-heading">
    <div><h1>{title}</h1>{description && <p>{description}</p>}</div>
    {actions && <div className="seller-actions">{actions}</div>}
  </header>;
}

export function SellerStatus({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warning" | "positive" }) {
  return <span className="seller-status" data-tone={tone}>{children}</span>;
}

export function SellerEmpty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="seller-empty"><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}

export function SellerPager({ page, hasNext, pageHref, label }: {
  page: number; hasNext: boolean; pageHref: (page: number) => string; label: string;
}) {
  if (page === 1 && !hasNext) return null;
  return <nav className="seller-pagination" aria-label={label}>
    {page > 1 && <Link className="seller-button" href={pageHref(page - 1)} prefetch={false}>Previous page</Link>}
    <span aria-current="page">Page {page}</span>
    {hasNext && <Link className="seller-button" href={pageHref(page + 1)} prefetch={false}>Next page</Link>}
  </nav>;
}

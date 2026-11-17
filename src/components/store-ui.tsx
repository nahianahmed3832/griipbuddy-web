import { ChevronRight, PackageSearch } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

type Crumb = { label: string; href?: string };

export function Breadcrumbs({ items }: { items: readonly Crumb[] }) {
  const trail: readonly Crumb[] = [{ label: "Home", href: "/" }, ...items];
  return (
    <nav aria-label="Breadcrumb" className="breadcrumbs">
      <ol>
        {trail.map(({ label, href }, index) => (
          <li key={`${index}:${label}`}>
            {index > 0 && <ChevronRight aria-hidden="true" size={13} />}
            {href ? <Link href={href}>{label}</Link> : <span aria-current="page">{label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function SectionHeading({ id, title, action }: {
  id: string;
  title: string;
  action?: { href: string; label: string };
}) {
  return (
    <div className="section-heading">
      <h2 id={id}>{title}</h2>
      {action && <Link className="section-heading__action" href={action.href} aria-label={`${action.label}: ${title}`}>{action.label}</Link>}
    </div>
  );
}

export function EmptyState({ title, description, children, icon }: {
  title: string;
  description: string;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <section className="empty-state" aria-label={title}>
      <div className="empty-state__icon">{icon ?? <PackageSearch aria-hidden="true" size={27} strokeWidth={1.5} />}</div>
      <h2 className="display-type">{title}</h2>
      <p>{description}</p>
      {children && <div className="empty-state__actions">{children}</div>}
    </section>
  );
}

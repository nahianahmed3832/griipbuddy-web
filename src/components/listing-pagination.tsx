import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import styles from "./listing-pagination.module.css";

type PageItem = number | "earlier" | "later";

function visiblePages(page: number, pageCount: number): PageItem[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
  if (page <= 4) return [1, 2, 3, 4, 5, "later", pageCount];
  if (page >= pageCount - 3) {
    return [1, "earlier", pageCount - 4, pageCount - 3, pageCount - 2, pageCount - 1, pageCount];
  }
  return [1, "earlier", page - 1, page, page + 1, "later", pageCount];
}

function PageDirection({ direction, href }: { direction: "prev" | "next"; href?: string }) {
  const previous = direction === "prev";
  const label = previous ? "Previous" : "Next";
  const contents = <>
    {previous && <ChevronLeft size={18} aria-hidden="true" />}
    <span className={styles.directionLabel}>{label}</span>
    {!previous && <ChevronRight size={18} aria-hidden="true" />}
  </>;

  return href
    ? <Link className={styles.direction} href={href} rel={direction} aria-label={`${label} page`}>{contents}</Link>
    : <span className={styles.direction} role="link" aria-disabled="true" aria-label={`${label} page`}>{contents}</span>;
}

export function ListingPagination({ page, pageCount, pageHref }: {
  page: number;
  pageCount: number;
  pageHref: (target: number) => string;
}) {
  if (pageCount <= 1) return null;

  return (
    <nav className={styles.pagination} aria-label="Product pagination">
      <PageDirection direction="prev" href={page > 1 ? pageHref(page - 1) : undefined} />
      <ol className={styles.pages} role="list">
        {visiblePages(page, pageCount).map(item => typeof item === "number" ? (
          <li key={item}>
            {item === page
              ? <span className={styles.page} aria-current="page"><span className="sr-only">Page </span>{item}</span>
              : <Link className={styles.page} href={pageHref(item)} aria-label={`Page ${item}`} prefetch={false}>{item}</Link>}
          </li>
        ) : <li className={styles.ellipsis} key={item} aria-hidden="true">…</li>)}
      </ol>
      <PageDirection direction="next" href={page < pageCount ? pageHref(page + 1) : undefined} />
    </nav>
  );
}

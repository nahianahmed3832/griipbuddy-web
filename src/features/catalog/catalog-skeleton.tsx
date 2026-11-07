export default function CatalogSkeleton() {
  return <div className="container storefront-loading" role="status">
    <span className="visually-hidden">Loading storefront…</span>
    <div className="skeleton-heading" aria-hidden />
    <div className="product-grid" aria-hidden>{[1, 2, 3, 4].map((item) => <div className="skeleton-tile" key={item} />)}</div>
  </div>;
}

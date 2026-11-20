import "./connected-browse-controls.css";
import "./connected-catalog-browse.css";

export default function CatalogBrowseLoading() {
  return <div className="shell inner-page connected-catalog catalog-browse-loading" aria-busy="true" role="status">
    <span className="sr-only">Loading products</span>
    <div aria-hidden="true" className="catalog-loading-heading" />
    <div className="connected-browse-results" aria-hidden="true">
      <div className="catalog-loading-sidebar" />
      <ul className="product-grid connected-catalog-grid">
        {Array.from({ length: 6 }, (_, index) => <li key={index} className="product-card__image" />)}
      </ul>
    </div>
  </div>;
}

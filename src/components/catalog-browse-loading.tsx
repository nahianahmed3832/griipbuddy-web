import "./connected-browse-controls.css";
import "./connected-catalog-browse.css";

export default function CatalogBrowseLoading({ destination = "products" }: { destination?: "products" | "category" | "collection" }) {
  return <div className="shell inner-page connected-catalog catalog-browse-loading">
    <span className="sr-only" role="status">Loading {destination}</span>
    <div aria-hidden="true">
      <div className="catalog-loading-heading" />
      {destination === "category" && <ul className="connected-category-shortcuts catalog-loading-shortcuts">
        {Array.from({ length: 4 }, (_, index) => <li key={index} />)}
      </ul>}
      <div className="connected-browse-results">
        <div className="catalog-loading-sidebar" />
        <ul className="product-grid connected-catalog-grid">
          {Array.from({ length: 6 }, (_, index) => <li key={index} className="product-card__image" />)}
        </ul>
      </div>
    </div>
  </div>;
}

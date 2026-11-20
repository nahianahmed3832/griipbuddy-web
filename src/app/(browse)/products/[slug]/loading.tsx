import "@/components/connected-product-detail.css";

export default function ProductLoading() {
  return <div className="shell inner-page" role="status" aria-busy="true">
    <span className="sr-only">Loading product details…</span>
    <div className="product-detail connected-product-detail connected-product-loading" aria-hidden="true">
      <div className="product-gallery__main" />
      <div className="product-detail__info">
        <div className="connected-product-loading__title" />
        <div className="connected-product-loading__line" />
        <div className="connected-product-loading__panel" />
      </div>
    </div>
  </div>;
}

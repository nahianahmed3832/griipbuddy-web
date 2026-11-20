export default function SellerLoading() {
  return <div className="seller-loading" role="status">
    <strong>Loading shop data…</strong>
    <div aria-hidden="true" className="seller-skeleton" />
    <div aria-hidden="true" className="seller-skeleton" />
  </div>;
}

"use client";

export default function SellerError({ retry }: { error: Error; retry: () => void }) {
  return <section className="seller-panel seller-empty" role="alert">
    <h1>Shop data is unavailable</h1>
    <p>Refresh this workspace to try again.</p>
    <button className="seller-button seller-button-primary" type="button" onClick={retry}>Try again</button>
  </section>;
}

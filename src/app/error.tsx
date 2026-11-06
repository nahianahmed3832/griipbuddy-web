'use client';

export default function CatalogErrorPage({ reset }: { reset: () => void }) {
  return <div className="container interior">
    <div className="empty-state">
      <h1>Catalog unavailable</h1>
      <p>The catalog could not be loaded. Try again in a moment.</p>
      <button type="button" className="button button-primary" onClick={reset}>Try again</button>
    </div>
  </div>;
}

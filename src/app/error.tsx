'use client';

export default function CatalogErrorPage({ reset }: { reset: () => void }) {
  return <div className="container interior">
    <div className="empty-state">
      <h1>This page couldn’t load</h1>
      <p>Try again in a moment.</p>
      <button type="button" className="button button-primary" onClick={reset}>Try again</button>
    </div>
  </div>;
}

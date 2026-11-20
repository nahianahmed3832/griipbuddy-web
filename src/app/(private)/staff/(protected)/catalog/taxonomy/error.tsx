"use client";

export default function TaxonomyError({ reset }: { reset: () => void }) {
  return <section className="commerce-panel" role="alert">
    <h2>The catalog workspace could not load</h2>
    <p>Try loading the workspace again.</p>
    <button type="button" className="button button--outline" onClick={reset}>Retry</button>
  </section>;
}

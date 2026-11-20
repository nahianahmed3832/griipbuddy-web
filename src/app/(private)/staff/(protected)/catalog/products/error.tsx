"use client";

export default function ProductWorkspaceError({ reset }: { reset: () => void }) {
  return <section className="commerce-panel" role="alert">
    <h2>The product workspace could not load</h2>
    <p>Try loading the product again.</p>
    <button className="button button--outline" type="button" onClick={reset}>Retry</button>
  </section>;
}

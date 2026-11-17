"use client";

import Link from "next/link";
import { AlertCircle } from "lucide-react";
import { EmptyState } from "@/components/store-ui";

export default function StoreError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="shell inner-page">
      <h1 className="display-type error-heading">Something went wrong</h1>
      <EmptyState title="We couldn’t load this page" description="Try again or return to the shop to keep browsing." icon={<AlertCircle aria-hidden="true" size={27} />}>
        <button className="button button--primary" type="button" onClick={reset}>Try again</button>
        <Link className="button button--outline" href="/shop">Shop all</Link>
      </EmptyState>
    </div>
  );
}

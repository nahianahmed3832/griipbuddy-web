import Link from "next/link";
import { EmptyState } from "@/components/store-ui";

export default function NotFound() {
  return (
    <div className="shell inner-page">
      <h1 className="display-type error-heading">Page not found</h1>
      <EmptyState title="This page has moved or is unavailable" description="Search for what you need or explore the catalog.">
        <Link className="button button--primary" href="/shop">Shop all products</Link>
        <Link className="button button--outline" href="/">Back to home</Link>
      </EmptyState>
    </div>
  );
}

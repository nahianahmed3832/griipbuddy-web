"use client";

import Form from "next/form";
import { usePathname, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";

export function SearchForm({ query = "" }: { query?: string }) {
  return (
    <Form action="/search" className="search-form" role="search" aria-label="Product search">
      <label htmlFor="store-search" className="sr-only">Search products</label>
      <input id="store-search" name="q" type="search" defaultValue={query} maxLength={120} placeholder="Search products" />
      <button type="submit" aria-label="Search"><Search aria-hidden="true" size={22} strokeWidth={2.3} /></button>
    </Form>
  );
}

export function HeaderSearch() {
  const pathname = usePathname();
  const params = useSearchParams();
  const query = pathname === "/search" ? params.get("q")?.slice(0, 120) ?? "" : "";
  return <SearchForm key={query} query={query} />;
}

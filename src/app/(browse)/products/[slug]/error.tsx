"use client";

import CatalogBrowseError from "@/components/catalog-browse-error";

export default function ProductError({ retry }: { retry: () => void }) {
  return <CatalogBrowseError retry={retry} title="We couldn’t load this product"
    description="Try loading the product again, or browse other products in your market." />;
}

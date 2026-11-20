import type { ReactNode } from "react";
import { StorefrontDocument, storeMetadata } from "@/components/storefront-document";
import { storefrontIndexingEnabled } from "@/lib/release-config";

export function generateMetadata() {
  return { ...storeMetadata, ...(!storefrontIndexingEnabled() && { robots: { index: false, follow: false } }) };
}

export default function BrowseLayout({ children }: { children: ReactNode }) {
  return <StorefrontDocument browse>{children}</StorefrontDocument>;
}

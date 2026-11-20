import type { ReactNode } from "react";
import { StorefrontDocument, storeMetadata } from "@/components/storefront-document";

export const metadata = storeMetadata;

export default function PrivateLayout({ children }: { children: ReactNode }) {
  return <StorefrontDocument>{children}</StorefrontDocument>;
}

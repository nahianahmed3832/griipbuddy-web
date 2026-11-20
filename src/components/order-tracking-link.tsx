import type { ReactNode } from "react";
import { storefrontPath } from "@/config/storefront-path";

export function OrderTrackingLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  // Start a fresh document so the previous order page's private server payload stays with it.
  return <a href={storefrontPath(href)} className={className} referrerPolicy="no-referrer">{children}</a>;
}

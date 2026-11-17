import type { MetadataRoute } from "next";
import { storefrontPath } from "@/config/storefront-path";
import { canonicalUrl, storefrontIndexingEnabled } from "@/lib/release-config";
import { merchantBdPreviewRobotsPaths } from "@/lib/catalog/merchant-bd-preview";
import { devLiveBangladeshFeed } from "@/lib/catalog/merchant-feed-config";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  if (devLiveBangladeshFeed()) {
    const paths = ["/feeds/bd.xml", ...merchantBdPreviewRobotsPaths()];
    const feed = { allow: paths.map(path => `${storefrontPath(path)}$`), disallow: "/" };
    return { rules: [{ userAgent: "*", ...feed }, { userAgent: ["AdsBot-Google", "AdsBot-Google-Mobile"], ...feed }] };
  }
  if (!storefrontIndexingEnabled()) return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: {
      userAgent: "*",
      allow: storefrontPath("/"),
      disallow: ["/cart", "/checkout", "/orders", "/staff", "/api", "/search"].map(storefrontPath),
    },
    sitemap: canonicalUrl("/sitemap.xml"),
  };
}

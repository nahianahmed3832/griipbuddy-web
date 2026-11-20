import type { NextConfig } from "next";
import { storefrontBasePath } from "./src/config/storefront-path";
import { marketList } from "./src/config/markets";

if (storefrontBasePath && !/^\/[a-z][a-z0-9-]*$/.test(storefrontBasePath)) {
  throw new Error("NEXT_PUBLIC_STOREFRONT_BASE_PATH must be empty or one path segment.");
}

const nextConfig: NextConfig = {
  basePath: storefrontBasePath,
  output: "standalone",
  poweredByHeader: false,
  async rewrites() {
    if (process.env.HYBRID_STOREFRONT_BUILD !== "1") return [];
    return { beforeFiles: [
      ...marketList.filter(market => market.pathPrefix).map(market => ({ source: `${market.pathPrefix}/:path*`, destination: "/:path*" })),
      { source: "/admin/sign-in", destination: "/staff/login" },
      { source: "/admin/:path*", destination: "/staff/:path*" },
    ], afterFiles: [], fallback: [] };
  },
  async headers() {
    const privateRoutes = ["/checkout", "/orders/:path*", "/staff/:path*", "/api/checkout", "/api/staff/:path*", "/api/measurement"];
    const referrerPolicy = process.env.HYBRID_STOREFRONT_BUILD === "1" ? "strict-origin" : "no-referrer";
    const sameOriginFormRoutes = ["/seller/finance", "/staff/seller-finance", "/staff/catalog/feeds"];
    return [{ source: "/:path*", headers: [{ key: "Referrer-Policy", value: referrerPolicy }] }, ...privateRoutes.map((source) => ({
      source,
      headers: [
        { key: "Cache-Control", value: "private, no-store, max-age=0" },
      ],
    })), ...sameOriginFormRoutes.map(source => ({
      source,
      headers: [
        { key: "Cache-Control", value: "private, no-store, max-age=0" },
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
        // Preserve the browser's Origin on same-origin form posts.
        { key: "Referrer-Policy", value: "same-origin" },
      ],
    }))];
  },
  images: {
    // The staging gate covers original image URLs. Next's internal optimizer fetch omits authorization.
    unoptimized: process.env.STAGING_BUILD === "1" || storefrontBasePath !== "",
    localPatterns: [{ pathname: "/catalog/**", search: "" }, { pathname: "/editorial/**", search: "" }, { pathname: "/media/**" }],
  },
};

export default nextConfig;

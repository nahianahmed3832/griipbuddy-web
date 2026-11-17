import type { NextConfig } from "next";
import { storefrontBasePath } from "./src/config/storefront-path";

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
      { source: "/bd/:path*", destination: "/:path*" },
      { source: "/admin/sign-in", destination: "/staff/login" },
      { source: "/admin/:path*", destination: "/staff/:path*" },
    ], afterFiles: [], fallback: [] };
  },
  async headers() {
    const privateRoutes = ["/checkout", "/staff/:path*", "/api/checkout", "/api/staff/:path*", "/api/measurement"];
    const sensitiveRoutes = ["/orders/:path*", "/bd/orders/:path*", "/account/:path*", "/bd/account/:path*", "/global-account/:path*", "/api/shopper-auth/:path*", "/api/shopper-handoff/:path*",
      "/staff/test-email", "/admin/test-email"];
    const referrerPolicy = process.env.HYBRID_STOREFRONT_BUILD === "1" ? "strict-origin" : "no-referrer";
    return [{ source: "/:path*", headers: [{ key: "Referrer-Policy", value: referrerPolicy }] }, ...privateRoutes.map((source) => ({
      source,
      headers: [
        { key: "Cache-Control", value: "private, no-store, max-age=0" },
      ],
    })), ...sensitiveRoutes.map((source) => ({
      source,
      headers: [
        { key: "Cache-Control", value: "private, no-store, max-age=0" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
      ],
    }))];
  },
  images: {
    // The staging gate covers original image URLs. Next's internal optimizer fetch omits authorization.
    unoptimized: process.env.STAGING_BUILD === "1" || storefrontBasePath !== "",
    localPatterns: [{ pathname: "/catalog/**", search: "" }, { pathname: "/editorial/**", search: "" }, { pathname: "/media/**", search: "" }],
  },
};

export default nextConfig;

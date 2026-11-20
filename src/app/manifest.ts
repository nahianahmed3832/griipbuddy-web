import type { MetadataRoute } from "next";
import { store } from "@/config/store";
import { storefrontPath } from "@/config/storefront-path";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: storefrontPath("/"),
    name: store.name,
    short_name: store.name,
    description: store.description,
    start_url: storefrontPath("/"),
    scope: storefrontPath("/"),
    display: "standalone",
    background_color: "#fff9f5",
    theme_color: "#542849",
    icons: [192, 512].map(size => ({
      src: storefrontPath(`/pwa/icon-${size}.png`), sizes: `${size}x${size}`, type: "image/png", purpose: "any",
    })),
  };
}

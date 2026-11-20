import type { Metadata } from "next";
import { Suspense } from "react";
import { HomeLoading, HomeMerchandising } from "@/components/marketplace/home";
import { currentMarket } from "@/lib/market-server";
import { canonicalUrl } from "@/lib/release-config";

export function generateMetadata(): Metadata {
  const canonical = canonicalUrl("/");
  return canonical ? { alternates: { canonical } } : {};
}

export default async function Home() {
  return <Suspense fallback={<HomeLoading />}><HomeMerchandising market={await currentMarket()} /></Suspense>;
}

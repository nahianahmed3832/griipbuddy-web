"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect } from "react";
import { isMarketId, type MarketId } from "@/config/markets";
import { withoutRegionalPrefix } from "@/config/regional-path";
import { storefrontBasePath } from "@/config/storefront-path";
import { useMeasurementChoice } from "@/lib/measurement/browser";
import { publicCampaignFields } from "@/lib/measurement/campaign";
import { replayChoice, setReplayChoice, useReplayChoice } from "@/lib/measurement/replay-choice";

type ClarityTag = ((...args: unknown[]) => void) & { q?: unknown[][] };
type ClarityWindow = Window & { clarity?: ClarityTag };
const consent = (allowed: boolean) => ({
  ad_Storage: "denied",
  analytics_Storage: allowed ? "granted" : "denied",
});

function replayPage(url: URL) {
  if (storefrontBasePath && url.pathname !== storefrontBasePath && !url.pathname.startsWith(storefrontBasePath + "/")) return;
  const path = withoutRegionalPrefix(url.pathname.slice(storefrontBasePath.length) || "/");
  if (url.hash) return;
  const campaign = publicCampaignFields(url.search);
  for (const [key, value] of url.searchParams) {
    if (url.searchParams.getAll(key).length !== 1) return;
    if (key === "market" && isMarketId(value)) continue;
    if (key === "variant" && /^v-[a-z0-9-]{1,65}$/.test(value) && path.startsWith("/products/")) continue;
    if (campaign && Object.hasOwn(campaign, key)) continue;
    return;
  }
  if (path === "/") return "home";
  if (/^\/products\/[a-z0-9-]+\/?$/.test(path)) return "product";
  if (/^\/(?:shop|gifts|(?:collections|departments)\/[a-z0-9-]+)\/?$/.test(path)) return "catalog";
}

function approvedReferrer() {
  if (!document.referrer) return true;
  const url = new URL(document.referrer);
  if (url.origin !== location.origin) return url.pathname === "/" && !url.search && !url.hash;
  return Boolean(replayPage(url));
}

let replay: { tag: ClarityTag; script: HTMLScriptElement; marketId: MarketId; project: string } | undefined;
let stopping = false;

function callClarity(...args: unknown[]) {
  try { (window as ClarityWindow).clarity?.(...args); } catch { /* Replay must not interrupt the store. */ }
}

function stopReplay() {
  if (!replay || stopping) return;
  stopping = true;
  const tag = (window as ClarityWindow).clarity;
  if (tag === replay.tag) {
    replay.script.remove();
  } else {
    callClarity("consentv2", consent(false));
    callClarity("stop");
  }
  // The hosted tag can restart in cookieless mode after a denied signal.
  // A fresh document removes that runtime and its pending callbacks.
  window.location.reload();
}

function startReplay(project: string, marketId: MarketId) {
  const browser = window as ClarityWindow;
  if (browser.clarity || replay || stopping || !replayChoice(marketId) || !replayPage(new URL(location.href))) return;
  const tag: ClarityTag = (...args) => (tag.q ??= []).push(args);
  const script = document.createElement("script");
  script.id = "griipbuddy-clarity";
  script.src = `https://www.clarity.ms/tag/${project}`;
  script.async = true;
  script.referrerPolicy = "no-referrer";
  replay = { tag, script, marketId, project };
  browser.clarity = tag;
  tag("consentv2", consent(true));
  tag("metadata", () => {
    const page = replayPage(new URL(location.href));
    if (!stopping && replay && page) {
      callClarity("set", "market", replay.marketId);
      callClarity("set", "page_type", page);
    }
  }, false, true);
  script.onerror = () => {
    if (browser.clarity === tag) delete browser.clarity;
    script.remove();
    replay = undefined;
  };
  document.head.append(script);
}

export function ClarityReplay({ project, marketId, eligible }: { project?: string; marketId: MarketId; eligible: boolean }) {
  const choice = useMeasurementChoice();
  const allowed = useReplayChoice(marketId) && choice === "on" && eligible && Boolean(project);
  const pathname = usePathname();
  const search = useSearchParams();

  useLayoutEffect(() => {
    if (choice === "blocked" || choice === "expired") setReplayChoice(false);
    if ((!allowed && choice !== "loading") || !replayPage(new URL(location.href)) ||
        (replay && (replay.project !== project || replay.marketId !== marketId))) stopReplay();
  }, [allowed, choice, pathname, search, marketId, project]);

  useEffect(() => {
    if (!project || !allowed || !approvedReferrer() || (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl) return;
    const start = () => startReplay(project, marketId);
    if (document.readyState === "complete") {
      const timer = window.setTimeout(start, 250);
      return () => window.clearTimeout(timer);
    }
    // Replay starts after storefront resources have finished loading.
    window.addEventListener("load", start, { once: true });
    return () => window.removeEventListener("load", start);
  }, [allowed, pathname, search, project, marketId]);

  return null;
}

"use client";

import { useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import type { MarketId } from "../../config/markets";
import { storefrontBasePath, storefrontPath } from "../../config/storefront-path";
import { useMeasurementChoice } from "../measurement/browser";
import { clearRecentHistory } from "./recent-history";

type Choice = "loading" | "on" | "off" | "blocked" | "unavailable";
type Status = { choice: Choice; scope: string | null };
type Action = "allow" | "disable" | "reset";
const loading: Status = { choice: "loading", scope: null };
const off: Status = { choice: "off", scope: null };
const blocked: Status = { choice: "blocked", scope: null };
const unavailable: Status = { choice: "unavailable", scope: null };
const statuses = new Map<MarketId, Status>();
const refreshKeys = new Map<MarketId, string>();
const requests = new Map<MarketId, Promise<void>>();
const listeners = new Set<() => void>();
let revision = 0;
let writing = false;
let channel: BroadcastChannel | null | undefined;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

function update(market: MarketId, status: Status) {
  const old = statuses.get(market);
  if (old?.choice === status.choice && old?.scope === status.scope) return;
  if (old?.scope && old.scope !== status.scope) clearRecentHistory();
  statuses.set(market, status);
  listeners.forEach(listener => listener());
}

function clearChoices() {
  revision++;
  statuses.clear();
  refreshKeys.clear();
  requests.clear();
  clearRecentHistory();
  listeners.forEach(listener => listener());
}

function connection() {
  if (channel !== undefined) return channel;
  try {
    channel = new BroadcastChannel(`griipbuddy:recommendation-preference${storefrontBasePath}`);
    channel.addEventListener("message", event => {
      if (event.data === "changing" || event.data === "changed") {
        writing = event.data === "changing";
        clearChoices();
      }
    });
  } catch { channel = null; }
  return channel;
}

async function request(action?: Action): Promise<Status> {
  const response = await fetch(storefrontPath("/api/recommendation-preferences"), {
    cache: "no-store", referrerPolicy: "no-referrer",
    signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(5_000) : undefined,
    ...(action && { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) }),
  });
  if (!response.ok) return unavailable;
  return await response.json() as Status;
}

function refresh(market: MarketId, key: string) {
  if (refreshKeys.get(market) === key || requests.has(market) || writing) return;
  refreshKeys.set(market, key);
  const current = revision;
  const pending = request().then(result => {
    if (revision === current) update(market, result);
  }).catch(() => {
    if (revision === current) update(market, unavailable);
  }).finally(() => {
    if (requests.get(market) === pending) requests.delete(market);
  });
  requests.set(market, pending);
}

export function useRecommendationStatus(marketId: MarketId) {
  const measurement = useMeasurementChoice();
  const path = usePathname();
  const epoch = useSyncExternalStore(subscribe, () => revision, () => 0);
  const status = useSyncExternalStore(subscribe, () => statuses.get(marketId) ?? loading, () => loading);
  useEffect(() => {
    if (measurement !== "on" && (statuses.size || refreshKeys.size || requests.size)) clearChoices();
  }, [measurement]);
  useEffect(() => {
    if (measurement !== "on") return;
    connection();
    const key = `${epoch}:${path}`;
    refresh(marketId, key);
    const verify = () => {
      if (document.visibilityState !== "visible") return;
      refreshKeys.delete(marketId);
      refresh(marketId, key);
    };
    window.addEventListener("pageshow", verify);
    document.addEventListener("visibilitychange", verify);
    return () => {
      window.removeEventListener("pageshow", verify);
      document.removeEventListener("visibilitychange", verify);
    };
  }, [measurement, marketId, path, epoch]);
  useEffect(() => {
    const clear = () => {
      if (statuses.size || refreshKeys.size || requests.size) clearChoices();
    };
    window.addEventListener("griipbuddy-measurement-session-ended", clear);
    return () => window.removeEventListener("griipbuddy-measurement-session-ended", clear);
  }, []);
  if (measurement === "blocked") return blocked;
  if (measurement !== "on") return off;
  return status;
}

export function useRecommendationChoice(marketId: MarketId) {
  return useRecommendationStatus(marketId).choice;
}

export async function chooseRecommendations(action: Action, marketId: MarketId) {
  writing = true;
  connection()?.postMessage("changing");
  clearChoices();
  const current = revision;
  let result: Status = unavailable;
  try { result = await request(action); }
  catch { /* Recheck on the next navigation or through an explicit retry. */ }
  finally {
    writing = false;
    if (current === revision) update(marketId, result);
    connection()?.postMessage("changed");
  }
  return result.choice === (action === "disable" ? "off" : "on");
}

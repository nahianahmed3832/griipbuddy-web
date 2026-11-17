"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { storefrontPath } from "../../config/storefront-path";
import { publicCampaignFields } from "./campaign";

type Choice = "loading" | "off" | "on" | "blocked" | "expired" | "unavailable";
let choice: Choice = "loading";
let initialized = false;
let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

function setChoice(value: Choice) {
  choice = value;
  listeners.forEach(listener => listener());
}

async function request(input?: object) {
  const response = await fetch(storefrontPath("/api/measurement"), {
    cache: "no-store", referrerPolicy: "no-referrer",
    ...(input ? {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      keepalive: true,
    } : {}),
  });
  return { status: response.status, choice: (await response.json()).choice as Choice };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useMeasurementChoice() {
  const state = useSyncExternalStore(subscribe, () => choice, () => "loading" as const);
  useEffect(() => {
    if (initialized) return;
    initialized = true;
    void request().then(result => setChoice(result.choice)).catch(() => setChoice("unavailable"));
  }, []);
  return state;
}

export async function chooseMeasurement(allow: boolean) {
  const old = choice;
  // A withdrawal stops queued and subsequent events immediately in this tab.
  if (!allow) setChoice("off");
  try {
    const result = await request({ action: allow ? "allow" : "withdraw" });
    if (result.status >= 400) {
      if (allow) setChoice(old);
      return false;
    }
    setChoice(result.choice);
    return true;
  } catch {
    if (allow) setChoice(old);
    return false;
  }
}

function track(input: object) {
  if (choice !== "on") return;
  queue = queue.catch(() => {}).then(async () => {
    if (choice !== "on") return;
    const result = await request(input);
    if (result.choice === "blocked" || result.status === 403) setChoice(result.choice);
  }).catch(() => {});
}

export function useProductMeasurement(variantId: string, marketId: string, enabled: boolean) {
  const state = useMeasurementChoice();
  const viewKey = useRef("");
  function observe() {
    if (!enabled || choice !== "on" || document.visibilityState !== "visible") return;
    const key = marketId + ":" + variantId;
    if (viewKey.current === key) return;
    viewKey.current = key;
    track({ action: "PRODUCT_VIEW", nonce: crypto.randomUUID(), variantId, campaign: publicCampaignFields(window.location.search) });
  }
  useEffect(() => {
    if (!enabled || state !== "on") return;
    // In a background tab, record the view only when the customer sees the page.
    observe();
    document.addEventListener("visibilitychange", observe);
    return () => document.removeEventListener("visibilitychange", observe);
    // Only the initial public variant, current market and consent define a view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, variantId, marketId, state]);
  return (addedVariantId: string, quantity: number) => {
    if (!enabled || choice !== "on") return;
    observe();
    track({ action: "CART_ADD", nonce: crypto.randomUUID(), variantId: addedVariantId, quantity });
  };
}

export function useCheckoutMeasurement(entered: boolean) {
  const state = useMeasurementChoice();
  const observed = useRef(false);
  useEffect(() => {
    if (!entered || state !== "on") return;
    const observe = () => {
      if (observed.current || document.visibilityState !== "visible") return;
      observed.current = true;
      track({ action: "CHECKOUT_START", nonce: crypto.randomUUID() });
    };
    observe();
    document.addEventListener("visibilitychange", observe);
    return () => document.removeEventListener("visibilitychange", observe);
  }, [entered, state]);
}

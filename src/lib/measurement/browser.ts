"use client";

import { useEffect, useEffectEvent, useRef, useSyncExternalStore } from "react";
import { getMarket, type MarketId } from "../../config/markets";
import { storefrontBasePath, storefrontPath } from "../../config/storefront-path";
import { clearRecentHistory } from "../catalog/recent-history";
import { campaignSources, publicCampaignFields, publicCampaignSource, type CampaignSource } from "./campaign";
import type { BrowserMeasurement, CheckoutFailure, CheckoutStep } from "./schema";

type Choice = "loading" | "off" | "on" | "blocked" | "expired" | "unavailable";
type BrowserEvent = Omit<BrowserMeasurement, "nonce" | "version" | "at" | "sessionId" | "campaign" | "campaignSource">;
type BrowserSession = { id: string; lastActivity: number; campaignSource: CampaignSource };
const sessionKey = `griipbuddy:measurement-session${storefrontBasePath}`;
const inactivityMs = 30 * 60 * 1000;
const maxPending = 160;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let choice: Choice = "loading";
let initialized = false;
let revision = 0;
let session: BrowserSession | undefined;
let channel: BroadcastChannel | undefined;
let queue: Promise<unknown> = Promise.resolve();
type PendingEvent = { payload: BrowserMeasurement; revision: number; started: boolean };
const pending = new Map<string, PendingEvent>();
const listeners = new Set<() => void>();

function setChoice(value: Choice) {
  if (value === choice) return;
  choice = value;
  revision++;
  if (value !== "on") {
    clearSession();
    pending.clear();
    queue = Promise.resolve();
  }
  if (value === "off" || value === "blocked" || value === "expired") clearRecentHistory();
  listeners.forEach(listener => listener());
}

function clearSession() {
  session = undefined;
  try { window.sessionStorage.removeItem(sessionKey); } catch { /* Storage can be disabled. */ }
}

export function endMeasurementSession() {
  revision++;
  clearSession();
  clearRecentHistory();
  window.dispatchEvent(new Event("griipbuddy-measurement-session-ended"));
}

async function request(input?: object) {
  const response = await fetch(storefrontPath("/api/measurement"), {
    cache: "no-store", referrerPolicy: "no-referrer",
    signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(5000) : undefined,
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

function refreshChoice() {
  const current = revision;
  void request().then(result => {
    if (current === revision) setChoice(result.choice);
  }).catch(() => {
    if (current === revision && choice === "loading") setChoice("unavailable");
  });
}

export function useMeasurementChoice() {
  const state = useSyncExternalStore(subscribe, () => choice, () => "loading" as const);
  useEffect(() => {
    if (initialized) return;
    initialized = true;
    refreshChoice();
    try {
      if (typeof BroadcastChannel === "function") {
        channel = new BroadcastChannel(sessionKey);
        channel.addEventListener("message", event => {
          if (event.data === "withdraw") setChoice("off");
          else if (event.data === "refresh") refreshChoice();
        });
      }
    } catch { /* The server still checks consent on each request. */ }
    window.addEventListener("pageshow", event => { if (event.persisted) refreshChoice(); });
    window.addEventListener("pagehide", flushForNavigation);
  }, []);
  return state;
}

export async function chooseMeasurement(allow: boolean) {
  const old = choice;
  if (!allow) {
    setChoice("off");
    channel?.postMessage("withdraw");
  }
  const current = ++revision;
  try {
    const result = await request({ action: allow ? "allow" : "withdraw" });
    if (current !== revision || result.status >= 400) return false;
    setChoice(result.choice);
    if (allow) channel?.postMessage("refresh");
    return true;
  } catch {
    if (allow && current === revision) setChoice(old);
    return false;
  }
}

function optedIn() {
  return choice === "on" && !(navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl;
}

function activeSession() {
  if (!optedIn() || typeof window.crypto?.randomUUID !== "function") return;
  const now = Date.now();
  if (!session) {
    try {
      const raw = window.sessionStorage.getItem(sessionKey);
      const stored: BrowserSession | null = raw ? JSON.parse(raw) : null;
      if (stored && uuid.test(stored.id) && Number.isFinite(stored.lastActivity) && campaignSources.includes(stored.campaignSource)) {
        session = stored;
      }
    } catch { /* This page can still use an in-memory session. */ }
  }
  if (session && now >= session.lastActivity && now - session.lastActivity < inactivityMs) session.lastActivity = now;
  else session = { id: crypto.randomUUID(), lastActivity: now,
    campaignSource: publicCampaignSource(window.location.search, document.referrer, window.location.origin) };
  try { window.sessionStorage.setItem(sessionKey, JSON.stringify(session)); } catch { /* Memory fallback. */ }
  return session;
}

export function measurementCheckoutHeaders(): Record<string, string> {
  const id = activeSession()?.id;
  return id ? { "x-griipbuddy-measurement-session": id } : {};
}

export function captureMeasurement() {
  const current = revision;
  return (input: BrowserEvent) => {
    if (current === revision) trackMeasurement(input);
  };
}

async function sendMeasurement(observation: PendingEvent) {
  if (!optedIn() || observation.revision !== revision || observation.started) return;
  observation.started = true;
  const result = await request(observation.payload);
  if (observation.revision === revision && (result.choice === "blocked" || result.status === 403 || result.choice === "expired")) {
    setChoice(result.choice);
  }
}

function flushForNavigation() {
  if (!optedIn()) return;
  const waiting = [...pending.values()].filter(event => !event.started && event.revision === revision);
  // Reserve browser keepalive capacity for actions that can lead to navigation.
  const isImpression = ({ payload }: PendingEvent) =>
    payload.action === "PRODUCT_IMPRESSION" || payload.action === "HOMEPAGE_SECTION_IMPRESSION" ||
    payload.action === "CATEGORY_IMPRESSION" || payload.action === "EXPERIMENT_EXPOSURE";
  waiting.sort((a, b) => Number(isImpression(a)) - Number(isImpression(b)));
  let capacity = 24 * 1024;
  const bytes = new TextEncoder();
  for (const event of waiting.slice(0, 24)) {
    const size = bytes.encode(JSON.stringify(event.payload)).length;
    if (size > capacity) break;
    capacity -= size;
    void sendMeasurement(event).catch(() => {});
  }
}

export function trackMeasurement(input: BrowserEvent) {
  if (pending.size >= maxPending) return;
  const currentSession = activeSession();
  if (!currentSession) return;
  const { id: sessionId, campaignSource } = currentSession;
  const nonce = crypto.randomUUID();
  const at = new Date().toISOString();
  const campaign = publicCampaignFields(window.location.search);
  const observation: PendingEvent = {
    payload: { ...input, nonce, at, version: 1, sessionId, campaign, campaignSource },
    revision, started: false,
  };
  pending.set(nonce, observation);
  queue = queue.then(() => sendMeasurement(observation)).catch(() => {}).finally(() => { pending.delete(nonce); });
}

export function useForegroundObservation(key: string, enabled: boolean, observe: () => void) {
  const state = useMeasurementChoice();
  const last = useRef("");
  const emit = useEffectEvent(observe);
  useEffect(() => {
    if (!enabled || state !== "on") return;
    const onVisible = () => {
      if (last.current === key || document.visibilityState !== "visible") return;
      last.current = key;
      emit();
    };
    onVisible();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [enabled, key, state]);
}

export function useProductMeasurement(productId: string, variantId: string, marketId: MarketId, priceMinor: number | undefined, enabled: boolean, offerId?: string) {
  useForegroundObservation(`${marketId}:${variantId}:${offerId ?? ""}`, enabled, () => trackMeasurement({
    action: "PRODUCT_VIEW", marketId, productId, variantId, offerId, displayedPriceMinor: priceMinor,
    currency: priceMinor === undefined ? undefined : getMarket(marketId).currency, placement: "product-detail",
  }));
}

type PurchaseContext = Pick<BrowserMeasurement, "productId" | "variantId" | "offerId">;

export function useCheckoutMeasurement(entered: boolean, marketId: MarketId, variantId?: string, terms?: Omit<PurchaseContext, "variantId">) {
  useForegroundObservation(`${marketId}:${variantId ?? "cart"}:${terms?.offerId ?? ""}`, entered, () => trackMeasurement({
    action: "CHECKOUT_START", marketId, variantId, ...terms, placement: "checkout",
  }));
}

export function checkoutStep(marketId: MarketId, step: CheckoutStep, failureCode?: CheckoutFailure, context?: PurchaseContext) {
  trackMeasurement(failureCode ? { ...context, action: "CHECKOUT_FAILURE", marketId, step, failureCode }
    : { ...context, action: "CHECKOUT_STEP", marketId, step });
}

export function checkoutFailureCode(kind: string): CheckoutFailure {
  if (kind === "invalid") return "VALIDATION";
  if (kind === "unavailable") return "UNAVAILABLE";
  if (kind === "abandoned") return "CANCELLED";
  return "REJECTED";
}

export function useCheckoutValidation(marketId: MarketId, context?: PurchaseContext) {
  const last = useRef(0);
  return () => {
    const now = Date.now();
    // Native validation fires an invalid event for every invalid field.
    if (now - last.current < 500) return;
    last.current = now;
    checkoutStep(marketId, "ADDRESS", "VALIDATION", context);
  };
}

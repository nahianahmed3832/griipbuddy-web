"use client";

import { useSyncExternalStore } from "react";
import { marketIds, type MarketId } from "../../config/markets";
import { storefrontBasePath } from "../../config/storefront-path";

const prefix = `griipbuddy:clarity-opt-in${storefrontBasePath}:`;
const changeEvent = "griipbuddy:clarity-choice";

function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(prefix) || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(changeEvent, listener);
  window.addEventListener("pageshow", listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(changeEvent, listener);
    window.removeEventListener("pageshow", listener);
  };
}

export function replayChoice(marketId: MarketId) {
  try { return window.localStorage.getItem(prefix + marketId) === "1"; } catch { return false; }
}

export function useReplayChoice(marketId: MarketId) {
  return useSyncExternalStore(subscribe, () => replayChoice(marketId), () => false);
}

export function setReplayChoice(allow: boolean, marketId?: MarketId) {
  try {
    if (allow && marketId) window.localStorage.setItem(prefix + marketId, "1");
    else for (const id of marketId ? [marketId] : marketIds) window.localStorage.removeItem(prefix + id);
  } catch {
    return false;
  }
  window.dispatchEvent(new Event(changeEvent));
  return true;
}

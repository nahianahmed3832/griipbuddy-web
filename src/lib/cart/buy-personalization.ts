"use client";

import { useSyncExternalStore } from "react";
import { storefrontBasePath } from "../../config/storefront-path";
import { personalizationText } from "../catalog/personalization";

const storageKey = "griipbuddy:buy-personalization" + storefrontBasePath;
type Draft = { id: string; variantId: string; text: string };
let lastDraft: Draft | undefined;

export function rememberBuyPersonalization(variantId: string, text: string) {
  const id = crypto.randomUUID();
  lastDraft = { id, variantId, text };
  try { window.sessionStorage.setItem(storageKey, JSON.stringify(lastDraft)); } catch { /* Navigation can use the in-memory draft. */ }
  return id;
}

function readDraft(id: string | undefined, variantId: string | undefined): string {
  if (!id || !variantId) return "";
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    const draft = (raw ? JSON.parse(raw) : undefined) as Draft | undefined;
    if (draft?.id === id && draft.variantId === variantId) return personalizationText(draft.text) ?? "";
  } catch { /* Use the in-memory draft if browser storage is unavailable. */ }
  return lastDraft?.id === id && lastDraft.variantId === variantId ? lastDraft.text : "";
}

function subscribe() {
  return () => {};
}

export function useBuyPersonalization(id: string | undefined, variantId: string | undefined) {
  return useSyncExternalStore(subscribe, () => readDraft(id, variantId), () => "");
}

export function clearBuyPersonalization(id: string | undefined, variantId: string | undefined) {
  if (!readDraft(id, variantId)) return;
  lastDraft = undefined;
  try { window.sessionStorage.removeItem(storageKey); } catch { /* The in-memory draft is already cleared. */ }
}

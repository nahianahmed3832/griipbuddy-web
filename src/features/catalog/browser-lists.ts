'use client';

import { useCallback, useSyncExternalStore } from 'react';

const memory = new Map<string, string>();
const changeEvent = 'griipbuddy-catalog-list-change';

function read(key: string) {
  try {
    return window.localStorage.getItem(key) ?? memory.get(key) ?? '[]';
  } catch {
    return memory.get(key) ?? '[]';
  }
}

function parse(snapshot: string) {
  try {
    const value: unknown = JSON.parse(snapshot);
    return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string'))] : [];
  } catch {
    return [];
  }
}

export function updateBrowserList(key: string, update: (previous: string[]) => string[]) {
  const value = JSON.stringify(update(parse(read(key))));
  memory.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Keep browsing available when the browser blocks persistent storage.
  }
  window.dispatchEvent(new Event(changeEvent));
}

function subscribe(listener: () => void) {
  window.addEventListener(changeEvent, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(changeEvent, listener);
    window.removeEventListener('storage', listener);
  };
}

export function useBrowserList(key: string) {
  const snapshot = useSyncExternalStore<string | null>(subscribe, useCallback(() => read(key), [key]), () => null);
  return { items: parse(snapshot ?? '[]'), hydrated: snapshot !== null };
}

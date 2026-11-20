"use client";

import { useEffect } from "react";
import { storefrontPath } from "@/config/storefront-path";

export function StorefrontInstallShell() {
  useEffect(() => {
    if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register(storefrontPath("/pwa-worker.js"), {
      scope: storefrontPath("/"),
      updateViaCache: "none",
    }).catch(() => {
      // Browsing is still available when this browser disallows registration.
    });
  }, []);
  return null;
}

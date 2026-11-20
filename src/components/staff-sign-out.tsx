"use client";

import { storefrontPath } from "@/config/storefront-path";

import { useState } from "react";

export function StaffSignOut() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  async function signOut() {
    if (pending) return;
    setPending(true);
    setError(false);
    try {
      const response = await fetch(storefrontPath("/api/staff/sign-out"), { method: "POST" });
      if (!response.ok) throw new Error("Sign-out failed");
      window.location.assign(storefrontPath("/staff/login"));
    } catch {
      setError(true);
      setPending(false);
    }
  }

  return (
    <>
      <button className="link-button" type="button" disabled={pending} onClick={signOut}>{pending ? "Signing out…" : "Sign out"}</button>
      {error && <span role="alert">Couldn’t sign out. Try again.</span>}
    </>
  );
}

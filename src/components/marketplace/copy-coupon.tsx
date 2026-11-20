"use client";

import { useState } from "react";

export function CopyCoupon({ code }: { code: string }) {
  const [message, setMessage] = useState("");
  return <div>
    <button type="button" className="button button--outline" aria-label={`Copy code ${code}`} onClick={async () => {
      try {
        await navigator.clipboard.writeText(code);
        setMessage("Code copied.");
      } catch {
        setMessage("Select the visible code and copy it manually.");
      }
    }}>Copy code</button>
    <span role="status">{message}</span>
  </div>;
}

"use client";

import { useState } from "react";
import { chooseMeasurement, useMeasurementChoice } from "@/lib/measurement/browser";

export function MeasurementPreferences() {
  const choice = useMeasurementChoice();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  if (choice === "loading" || choice === "unavailable") return null;

  async function choose(allow: boolean) {
    setPending(true);
    const saved = await chooseMeasurement(allow);
    setPending(false);
    setMessage(saved ? (allow ? "Your choice was saved." : "Shopping measurement is off.") : "We couldn’t save the change. Please try again.");
  }

  return <details className="measurement-preferences">
    <summary>Privacy choices</summary>
    <p>Optional shopping measurement helps GriipBuddy see whether product visits lead to orders. It uses a random identifier for up to seven days. We keep records for up to 30 days. It does not send this data to advertising or analytics providers.</p>
    {choice === "blocked" && <p>Your browser’s Global Privacy Control is on. Shopping measurement is off.</p>}
      <div className="measurement-preferences__actions">
        {choice !== "on" && choice !== "blocked" && <button type="button" className="button button--outline" disabled={pending} onClick={() => void choose(true)}>Allow shopping measurement</button>}
        <button type="button" className="button button--outline" disabled={pending} onClick={() => void choose(false)}>
          {choice === "on" || choice === "expired" || choice === "blocked" ? "Withdraw and delete measurement" : "Keep measurement off"}
        </button>
      </div>
    <p aria-live="polite">{message}</p>
  </details>;
}

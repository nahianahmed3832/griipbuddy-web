"use client";

import { useState } from "react";
import type { MarketId } from "@/config/markets";
import { chooseMeasurement, useMeasurementChoice } from "@/lib/measurement/browser";
import { setReplayChoice, useReplayChoice } from "@/lib/measurement/replay-choice";
import { chooseRecommendations, useRecommendationChoice } from "@/lib/catalog/recommendation-preference-client";

export function MeasurementPreferences({ marketId, clarityEnabled = false }: { marketId: MarketId; clarityEnabled?: boolean }) {
  const choice = useMeasurementChoice();
  const replay = useReplayChoice(marketId);
  const recommendation = useRecommendationChoice(marketId);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  if (choice === "loading" || choice === "unavailable") return null;

  async function choose(allow: boolean) {
    setPending(true);
    setReplayChoice(false);
    const saved = await chooseMeasurement(allow);
    setPending(false);
    setMessage(saved ? (allow ? "Your choice was saved." : "Shopping measurement is off.") : "We couldn’t save the change. Please try again.");
  }

  async function chooseRecommendation(action: "allow" | "disable" | "reset") {
    setPending(true);
    const saved = await chooseRecommendations(action, marketId);
    setPending(false);
    setMessage(saved ? {
      allow: "Personalized recommendations are on.",
      disable: "Personalized recommendations are off.",
      reset: "Your recommendation history has been reset.",
    }[action] : "We couldn’t save the change. Please try again.");
  }

  return <details className="measurement-preferences" data-measurement-choice={choice}>
    <summary>Privacy choices</summary>
    <p>Required storage supports market selection, shopping bags and account sessions. Optional measurement uses a separate choice.</p>
    <p>Optional shopping measurement helps GriipBuddy see whether product visits lead to orders. It uses a random identifier for up to seven days, and GriipBuddy keeps these records for up to 30 days.</p>
    {choice === "blocked" && <p>Shopping measurement is disabled for this browser or staff session.</p>}
      <div className="measurement-preferences__actions">
        {choice !== "on" && choice !== "blocked" && <button type="button" className="button button--outline" disabled={pending} onClick={() => void choose(true)}>Allow shopping measurement</button>}
        <button type="button" className="button button--outline" disabled={pending} onClick={() => void choose(false)}>
          {choice === "on" || choice === "expired" || choice === "blocked" ? "Withdraw and delete measurement" : "Keep measurement off"}
        </button>
      </div>
    {choice === "on" && <>
      <p>With your permission, personalized recommendations use recent browsing, searches, saved items, cart activity and purchases in your market. During sign-in, your shopping journey can be associated with your account. This browser’s preference lasts for the measurement journey.</p>
      <div className="measurement-preferences__actions">
        <button type="button" className="button button--outline" disabled={pending || recommendation === "loading"}
          onClick={() => void chooseRecommendation(recommendation === "on" ? "disable" : "allow")}>
          {recommendation === "on" ? "Turn off personalized recommendations" : "Allow personalized recommendations"}
        </button>
        {recommendation === "on" && <button type="button" className="button button--outline" disabled={pending}
          onClick={() => void chooseRecommendation("reset")}>Reset recommendation history</button>}
      </div>
    </>}
    {clarityEnabled && choice === "on" && <>
      <p>Optional Microsoft Clarity replay helps us see how shoppers use public browsing pages. It uses analytics cookies. Account, search, cart, and payment pages are excluded.</p>
      <button type="button" className="button button--outline" disabled={pending} onClick={() => {
        if (!setReplayChoice(!replay, marketId)) setMessage("This browser couldn’t save your replay choice.");
      }}>{replay ? "Turn off session replay" : "Allow session replay"}</button>
    </>}
    <p aria-live="polite">{message}</p>
  </details>;
}

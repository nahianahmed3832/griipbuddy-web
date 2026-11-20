"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import type { MarketId } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import type { AnalystAnswer } from "@/lib/intelligence/analyst";

const providerStatus: Record<Exclude<AnalystAnswer["connection"], "configured">, string> = {
  "not-configured": "LLM explanation is unconfigured. This answer uses deterministic evidence.",
  unavailable: "The explanation provider is unavailable. This answer uses deterministic evidence.",
  limited: "The explanation provider has reached its request limit. This answer uses deterministic evidence.",
};

export function IntelligenceAnalyst({ market, marketName, test, from, to, choices, product, variant }: {
  market: MarketId; marketName: string; test: boolean; from: string; to: string; choices: readonly string[]; product?: string; variant?: string;
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AnalystAnswer>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function ask(input: string) {
    if (pending || !input.trim()) return;
    setQuestion(input);
    setPending(true);
    setError("");
    setAnswer(undefined);
    try {
      const response = await fetch(storefrontPath("/api/staff/intelligence/analyst"), {
        method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ question: input, marketId: market, test, from, to, productId: product, variantId: variant }),
      });
      const result = await response.json();
      if (!response.ok) setError(result.error ?? "The analyst is temporarily unavailable.");
      else setAnswer(result.answer);
    } catch { setError("The analyst could not load the evidence. Refresh the report or try again."); }
    finally { setPending(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(question);
  }

  return <section className="commerce-panel intel-panel" aria-labelledby="analyst-heading">
    <h2 id="analyst-heading">Ask the analyst</h2>
    <p>Responses use market-level evidence and link to the underlying report. Enter a business question without customer or supplier contact details.</p>
    <div className="intel-tabs" aria-label="Suggested questions">{choices.map(choice => <button type="button" className="button button--outline"
      key={choice} disabled={pending} onClick={() => void ask(choice)}>{choice}</button>)}</div>
    <form onSubmit={submit} className="commerce-form">
      <label>Question<textarea required value={question} onChange={event => setQuestion(event.target.value)} rows={3} maxLength={240} /></label>
      <button className="button button--primary" disabled={pending} type="submit">{pending ? "Reading market evidence…" : "Ask analyst"}</button>
    </form>
    {error && <p role="status">{error}</p>}
    {answer && <section className="intel-panel" aria-live="polite">
      <h3>{answer.question}</h3>
      <p className="intel-meta">{marketName} · {answer.window.from} – {answer.window.to} · {answer.test ? "Staging fixtures and test evidence" : "Production evidence"}</p>
      <h4>Observed facts</h4>
      <ul>{answer.facts.map((item, index) => <li key={index}>{item.text} <Link href={item.href}>Source view</Link></li>)}</ul>
      <h4>Hypotheses to investigate</h4>
      <ul>{answer.hypotheses.map((item, index) => <li key={index}>{item.text} <Link href={item.href}>Supporting evidence</Link></li>)}</ul>
      {answer.explanation && answer.explanationHref && <p><strong>AI-assisted investigation</strong> {answer.explanation} <Link href={answer.explanationHref}>Supporting evidence</Link></p>}
      {answer.connection !== "configured" && <p className="intel-muted">{providerStatus[answer.connection]}</p>}
    </section>}
  </section>;
}

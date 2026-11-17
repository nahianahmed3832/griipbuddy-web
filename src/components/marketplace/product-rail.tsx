"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";
import { useId, useRef, type ReactNode } from "react";
import styles from "./product-rail.module.css";

export function ProductRail({ children }: { children: ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const trackId = useId();

  function scroll(direction: number) {
    const element = track.current;
    const item = element?.querySelector("li");
    if (!element || !item) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Advance to the next snap point while preserving how many items fit on screen.
    element.scrollBy({ left: direction * (item.getBoundingClientRect().width + 16),
      behavior: reducedMotion ? "instant" : "smooth" });
  }

  return <div className={styles.rail}>
    <div className={styles.controls}>
      <button type="button" aria-label="Previous products" aria-controls={trackId} onClick={() => scroll(-1)}><ArrowLeft size={18}/></button>
      <button type="button" aria-label="Next products" aria-controls={trackId} onClick={() => scroll(1)}><ArrowRight size={18}/></button>
    </div>
    <div id={trackId} ref={track} className={styles.track}>{children}</div>
  </div>;
}

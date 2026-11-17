"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function SaleCountdown({ endsAt, initialSeconds }: { endsAt: string; initialSeconds: number }) {
  const [seconds, setSeconds] = useState(initialSeconds);
  const router = useRouter();
  useEffect(() => {
    const ending = Date.parse(endsAt);
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((ending - Date.now()) / 1000));
      setSeconds(remaining);
      if (remaining === 0) {
        window.clearInterval(timer);
        router.refresh();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [endsAt, router]);

  if (seconds === 0) return <span>Featured offer ended</span>;

  const days = Math.floor(seconds / 86400);
  const duration = [Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60]
    .map(number => String(number).padStart(2, "0")).join(":");
  return <span aria-hidden="true">Featured offer ends in <strong>{days ? `${days}d ` : ""}{duration}</strong></span>;
}

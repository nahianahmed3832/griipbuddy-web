"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Timer } from "lucide-react";

export function SaleCountdown({
  endsAt, initialSeconds, deadlineLabel, label = "Featured offer ends in", endedLabel = "Featured offer ended",
}: {
  endsAt: string;
  initialSeconds: number;
  deadlineLabel: string;
  label?: string;
  endedLabel?: string;
}) {
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

  if (seconds === 0) return <span>{endedLabel}</span>;

  const units = [
    { name: "days", short: "Days", value: Math.floor(seconds / 86400) },
    { name: "hours", short: "Hrs", value: Math.floor(seconds / 3600) % 24 },
    { name: "minutes", short: "Min", value: Math.floor(seconds / 60) % 60 },
    { name: "seconds", short: "Sec", value: seconds % 60 },
  ];
  return (
    <span className="mp-countdown" role="timer">
      <span aria-hidden="true" className="mp-countdown__label"><Timer size={16} />{label}</span>
      <span aria-hidden="true" className="mp-countdown__units">
        {units.map(({ name, short, value }) => (
          <span className="mp-countdown__unit" data-countdown-unit={name} key={name}>
            <strong>{String(value).padStart(2, "0")}</strong>
            <small>{short}</small>
          </span>
        ))}
      </span>
      <span className="sr-only">
        {label} {units.map(({ name, value }) => `${value} ${value === 1 ? name.slice(0, -1) : name}`).join(", ")}.
        {" "}Deadline: <time dateTime={endsAt}>{deadlineLabel}</time>.
      </span>
    </span>
  );
}

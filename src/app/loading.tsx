import { LoaderCircle } from "lucide-react";

export default function Loading() {
  return (
    <div className="shell inner-page">
      <div className="state-panel" role="status"><LoaderCircle className="spinner" aria-hidden="true" size={22} /> Loading the store…</div>
    </div>
  );
}

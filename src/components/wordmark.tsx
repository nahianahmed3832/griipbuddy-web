import Link from "next/link";
import { store } from "@/config/store";

export function Wordmark() {
  return <Link className="wordmark" href="/" aria-label={`${store.name} home`}>{store.name}</Link>;
}

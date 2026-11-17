import Link from "next/link";
import { store } from "@/config/store";

export function Wordmark({ href = "/" }: { href?: string }) {
  return <Link className="wordmark" href={href} aria-label={`${store.name} home`}>{store.name}</Link>;
}

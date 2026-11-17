import Link from "next/link";
import type { Market } from "@/config/markets";
import type { Department } from "@/lib/catalog/types";
import { store } from "@/config/store";
import { MarketPicker } from "./market-picker";
import { Wordmark } from "./wordmark";
import { MeasurementPreferences } from "./measurement-preferences";

export function SiteFooter({ departments, market, production }: { departments: readonly Department[]; market: Market; production: boolean }) {
  return (
    <footer className="site-footer">
      <div className="shell">
        <div className="site-footer__grid">
          <div className="site-footer__brand">
            <Wordmark />
            <p>{store.description}</p>
          </div>
          <nav aria-label="Footer departments">
            <h2>Departments</h2>
            {departments.map((department) => (
              <Link key={department.id} href={`/departments/${department.slug}`}>{department.shortName}</Link>
            ))}
          </nav>
          <nav aria-label="Footer collections">
            <h2>Discover</h2>
            <Link href="/shop">Shop all</Link>
            {!production && <>
              <Link href="/collections/new-arrivals">New arrivals</Link>
              <Link href="/collections/featured">Featured picks</Link>
            </>}
            <Link href="/cart">Your cart</Link>
          </nav>
          <div>
            <h2>Support</h2>
            {store.supportEmail && <a href={`mailto:${store.supportEmail}`}>{store.supportEmail}</a>}
            <Link href="/staff/login" prefetch={false}>Staff sign-in</Link>
            {store.policies.map((policy) => <Link key={policy.href} href={policy.href}>{policy.label}</Link>)}
          </div>
        </div>
        <div className="site-footer__bottom">
          <MarketPicker market={market} />
          <span>{production ? store.name : store.previewNotice}</span>
        </div>
        {(production ? process.env.ACQUISITION_MEASUREMENT === "1" : true) && <MeasurementPreferences />}
      </div>
    </footer>
  );
}

import Link from "next/link";
import { UserRound } from "lucide-react";
import { Suspense } from "react";
import { store } from "@/config/store";
import type { Department } from "@/lib/catalog/types";
import { CartLink } from "./cart-link";
import { DepartmentMenu } from "./department-menu";
import { HeaderSearch, SearchForm } from "./search-form";
import { SignIn } from "./sign-in";
import { Wordmark } from "./wordmark";

export function SiteHeader({ departments, signedIn, production }: { departments: readonly Department[]; signedIn: boolean; production: boolean }) {
  return (
    <header className="site-header">
      {!production && <div className="preview-strip">{store.previewNotice}</div>}
      <div className="shell site-header__row">
        <Wordmark />
        <DepartmentMenu departments={departments} />
        <div className="site-header__search"><Suspense fallback={<SearchForm />}><HeaderSearch /></Suspense></div>
        {production ? <Link className="account-control__trigger" href="/orders" aria-label="Your orders"><UserRound size={17} aria-hidden="true" /> Orders</Link> : <SignIn signedIn={signedIn} />}
        <CartLink />
      </div>
      <nav className="shell site-nav__items" aria-label="Departments">
        {!production && <Link href="/collections/new-arrivals">New arrivals</Link>}
        {departments.map((department) => (
          <Link key={department.id} href={`/departments/${department.slug}`}>{department.shortName}</Link>
        ))}
        <Link href="/shop">Shop all</Link>
      </nav>
    </header>
  );
}

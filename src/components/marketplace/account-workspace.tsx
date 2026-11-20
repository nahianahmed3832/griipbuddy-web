import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight, Bell, CircleUserRound, Heart, MapPin, MessageCircle, Package, Shield, Tag } from "lucide-react";
import type { Market } from "@/config/markets";
import styles from "./account-workspace.module.css";

const accountLinks = [
  { title: "Overview", href: "/account", icon: CircleUserRound },
  { title: "Orders", href: "/orders", icon: Package },
  { title: "Saved products", href: "/favorites", icon: Heart },
  { title: "Addresses", href: "/account#addresses", icon: MapPin },
  { title: "Messages", href: "/messages", icon: MessageCircle },
  { title: "Notifications", href: "/account/notifications", icon: Bell },
  { title: "Product alerts", href: "/account/alerts", icon: Bell },
  { title: "Offers", href: "/account/coupons", icon: Tag },
  { title: "Security & privacy", href: "/account#security", icon: Shield },
];

export function AccountWorkspace({ title, description, market, active, children }: {
  title: string;
  description?: string;
  market: Market;
  active?: string;
  children: ReactNode;
}) {
  return <div className={`shell inner-page ${styles.workspace}`} data-clarity-mask="true">
    <header className={styles.heading}>
      <div><h1 className="display-type">{title}</h1>{description && <p>{description}</p>}</div>
      <span className={styles.market}>{market.name} <span aria-hidden="true">·</span> {market.currency}</span>
    </header>
    <div className={styles.layout}>
      {active && <nav className={styles.navigation} aria-label="Customer account">
        {accountLinks.map(({ title, href, icon: Icon }) => <Link href={href} key={href} aria-current={href === active ? "page" : undefined} prefetch={false}>
          <Icon size={17} aria-hidden="true"/><span>{title}</span>
        </Link>)}
      </nav>}
      <div className={styles.content}>{children}</div>
    </div>
  </div>;
}

export function AccountPanel({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return <section className={styles.panel} id={id}>
    <h2>{title}</h2>{children}
  </section>;
}

export function AccountShortcuts({ children }: { children: ReactNode }) {
  return <ul className={styles.shortcuts}>{children}</ul>;
}

export function AccountShortcut({ title, summary, href }: { title: string; summary: string; href: string }) {
  return <li><Link href={href} prefetch={false}><span><strong>{title}</strong><small>{summary}</small></span>
    <ArrowUpRight size={18} aria-hidden="true"/></Link></li>;
}

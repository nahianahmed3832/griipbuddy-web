import { ArrowUpRight, Globe, Headphones, PackageOpen } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { categoryHref, marketHref, type Category, type Market } from '@/features/catalog/catalog';

const support = [
  ['/contact-and-support', 'Contact & support'],
  ['/shipping-procedure', 'Shipping information'],
  ['/returns-and-exchange', 'Returns & exchanges'],
] as const;

const information = [
  ['/about-us', 'About GriipBuddy'],
  ['/privacy-and-policy', 'Privacy policy'],
  ['/terms-and-conditions', 'Terms & conditions'],
] as const;

export function Footer({ market, categories, onMarket }: { market: Market; categories: Category[]; onMarket: (trigger: HTMLButtonElement) => void }) {
  return (
    <footer className="footer">
      <div className="trust">
        <div className="container trust-grid">
          <div><Globe aria-hidden /><span><strong>Shop by market</strong><small>Browse in your local currency.</small></span></div>
          <div><PackageOpen aria-hidden /><span><strong>Returns information</strong><Link href={marketHref(market, '/returns-and-exchange')}>See returns & exchanges.</Link></span></div>
          <div><Headphones aria-hidden /><span><strong>Here to help</strong><Link href={marketHref(market, '/contact-and-support')}>Find contact & support.</Link></span></div>
        </div>
      </div>
      <div className="container">
        <div className="footer-main">
          <div className="footer-brand">
            <Link href={marketHref(market)} aria-label="GriipBuddy home"><Image src="/brand/griipbuddy-wordmark.webp" width={172} height={43} alt="GriipBuddy" /></Link>
            <p>Considered accessories and everyday favorites, all in one place.</p>
          </div>
          <nav aria-label="Shop"><h2>Explore</h2>{categories.map((category) => (
            <Link key={category.id} href={categoryHref(market, category.path)}>{category.label}</Link>
          ))}</nav>
          <nav aria-label="Help"><h2>Help</h2>{support.map(([path, label]) => <Link key={path} href={marketHref(market, path)}>{label}</Link>)}</nav>
          <nav aria-label="Information"><h2>GriipBuddy</h2>{information.map(([path, label]) => <Link key={path} href={marketHref(market, path)}>{label}</Link>)}</nav>
        </div>
        <div className="footer-bottom">
          <small>© GriipBuddy</small>
          <button type="button" className="footer-market" onClick={(event) => onMarket(event.currentTarget)}><Globe size={16} aria-hidden /> {market.name} · {market.currency} <ArrowUpRight size={15} aria-hidden /></button>
        </div>
      </div>
    </footer>
  );
}

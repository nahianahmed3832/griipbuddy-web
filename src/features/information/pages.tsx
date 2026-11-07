import { ArrowRight, ArrowUpRight, Globe, Headphones, Heart, Info, PackageOpen, RotateCcw, ScrollText, ShieldCheck, UserRound } from 'lucide-react';
import Link from 'next/link';
import { marketHref, type Market } from '@/features/catalog/catalog';

export const information = {
  'about-us': {
    title: 'About GriipBuddy',
    description: 'Discover products for everyday life, with an assortment and prices specific to your market.',
    icon: Info,
    sections: [
      ['Explore the catalog', 'Browse by category or search by product, device or brand. Open a product to see its available options and delivery details.'],
      ['Shop your market', 'Use the country selector to see the products and currency available for your market. Your cart checks delivery separately.'],
    ],
  },
  'contact-and-support': {
    title: 'Contact & support',
    description: 'Find help with shopping, your market, delivery and returns.',
    icon: Headphones,
    sections: [
      ['Products and availability', 'Select a variant on the product page to see its price and availability. The cart rechecks both before checkout.'],
      ['Market and currency', 'You can change your market from the country selector. Choose automatic location to use your approximate country again.'],
    ],
  },
  'shipping-procedure': {
    title: 'Shipping information',
    description: 'Check delivery information for the product and market you are shopping in.',
    icon: PackageOpen,
    sections: [
      ['Before adding to cart', 'Open Delivery & returns on the product page for any published delivery information.'],
      ['Review delivery in your cart', 'Your cart checks delivery eligibility and shows an estimate when one is available. Delivery shown in the development preview is simulated.'],
    ],
  },
  'returns-and-exchange': {
    title: 'Returns & exchanges',
    description: 'Find return information for the item you are considering.',
    icon: RotateCcw,
    sections: [
      ['Check product details', 'Open Delivery & returns on the product page to see any return information published for that item.'],
      ['Review an existing order', 'When customer accounts are available, open your order history to see order details and available actions. Storewide return terms are pending publication.'],
    ],
  },
  'privacy-and-policy': {
    title: 'Privacy policy',
    description: 'The full storefront privacy policy is pending publication.',
    icon: ShieldCheck,
    sections: [
      ['Market selection', 'Automatic location uses a country-level estimate from your IP address. You can choose another market in the country selector.'],
      ['Saved preferences', 'Your market choice and items saved as a guest can be remembered on this browser.'],
    ],
  },
  'terms-and-conditions': {
    title: 'Terms & conditions',
    description: 'The full storefront terms are pending publication.',
    icon: ScrollText,
    sections: [
      ['Catalog and pricing', 'Displayed prices and availability depend on the selected market and variant. Your cart rechecks prices and stock.'],
      ['Checkout preview', 'The development storefront uses simulated checkout.'],
    ],
  },
} as const;

export type InformationPageKey = keyof typeof information;

const helpLinks = ['contact-and-support', 'shipping-procedure', 'returns-and-exchange', 'about-us', 'privacy-and-policy', 'terms-and-conditions'] as const;

function TileLink({ market, path, label, description, icon: Icon }: {
  market: Market; path: string; label: string; description?: string; icon: typeof Info;
}) {
  return <Link className="guide-link" href={marketHref(market, path)}>
    <Icon size={19} aria-hidden />
    <span><strong>{label}</strong>{description && <small>{description}</small>}</span>
    <ArrowUpRight size={16} aria-hidden />
  </Link>;
}

export function InformationPage({ market, slug }: { market: Market; slug: InformationPageKey }) {
  const { title, description, icon: Icon, sections } = information[slug];
  return <div className="container guide-page">
    <Link className="back-link" href={marketHref(market)}>Home <ArrowRight size={14} aria-hidden /></Link>
    <header className="guide-heading">
      <div><p className="eyebrow">THE GRIIPBUDDY GUIDE</p><h1>{title}</h1><p>{description}</p></div>
      <Icon aria-hidden />
    </header>
    <div className="guide-layout">
      <div className="guide-sections">{sections.map(([heading, body]) => <section key={heading}><h2>{heading}</h2><p>{body}</p></section>)}</div>
      <nav className="guide-navigation" aria-label="More information">
        <h2>More information</h2>
        {helpLinks.filter(key => key !== slug).map(key => <TileLink key={key} market={market} path={'/' + key}
          label={information[key].title} icon={information[key].icon} />)}
      </nav>
    </div>
  </div>;
}

export function ProfilePage({ market, accountsEnabled, signedIn }: { market: Market; accountsEnabled: boolean; signedIn: boolean }) {
  return <div className="container guide-page profile-page">
    <header className="guide-heading">
      <div><p className="eyebrow">YOUR GRIIPBUDDY</p><h1>Profile</h1><p>Find your saved products, shopping preferences, and help.</p></div>
      <UserRound aria-hidden />
    </header>
    <div className="guide-layout">
      <section className="guide-navigation" aria-label="Your shopping">
        <h2>Your shopping</h2>
        {accountsEnabled && <TileLink market={market} path={signedIn ? '/account' : '/login'} label={signedIn ? 'My account' : 'Sign in'}
          description="Access your account and order history." icon={UserRound} />}
        <TileLink market={market} path="/wishlist" label="Saved items" description="Find the products you’ve saved." icon={Heart} />
        <TileLink market={market} path="/rewards" label="Rewards" description="See rewards availability in your market." icon={Info} />
      </section>
      <section className="guide-navigation" aria-label="Shopping settings">
        <h2>Shopping settings</h2>
        <div className="guide-market"><Globe size={19} aria-hidden /><span><strong>{market.name} · {market.currency}</strong>
          <small>Use the country selector to change your market.</small></span></div>
        <TileLink market={market} path="/contact-and-support" label="Contact & support" icon={Headphones} />
      </section>
    </div>
  </div>;
}

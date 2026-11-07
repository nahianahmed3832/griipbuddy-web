import { ArrowRight, Gift, Globe, LoaderCircle, Sparkles, Ticket, Users, Zap } from 'lucide-react';
import Link from 'next/link';
import { Suspense } from 'react';
import { marketHref, type Market } from '@/features/catalog/catalog';
import { catalogProduct, catalogSample, mapLimited } from '@/features/catalog/data';
import { ProductWatchlist } from '@/features/catalog/product-watch';
import { CatalogGrid } from '@/features/catalog/listing';
import { ShoppingHistory } from '@/features/catalog/saved-products';
import { fixturesEnabled } from '@/features/public-build';
import { campaigns, couponOffers } from './source';
import { CampaignClock, CouponWallet, GroupProgress, ShareLink } from './interactions';

export const discoveryPages = {
  discover: { title: 'Discover', description: 'Browse new finds and pick up where you left off.', icon: Sparkles },
  deals: { title: 'Deals', description: 'Explore sale prices and active campaigns in your market.', icon: Zap },
  'group-buy': { title: 'Group Buy', description: 'Find offers you can explore and share with friends.', icon: Users },
  coupons: { title: 'Coupon center', description: 'Find market offers and save codes for your next shop.', icon: Ticket },
  rewards: { title: 'Rewards', description: 'Find program terms and membership benefits when available in your market.', icon: Gift },
} as const;

export type DiscoveryPageKey = keyof typeof discoveryPages;

function ShopLink({ market }: { market: Market }) {
  return <Link href={marketHref(market, '/products')} className="button button-primary">Browse the catalog <ArrowRight size={17} aria-hidden /></Link>;
}

export async function DiscoveryPage({ market, page }: { market: Market; page: DiscoveryPageKey }) {
  const { title, description, icon: Icon } = discoveryPages[page];
  return <div className="container discovery-page">
    <Link className="back-link" href={marketHref(market)}>← Home</Link>
    <header className={'discovery-heading discovery-' + page}>
      <div><p className="eyebrow">THE GRIIPBUDDY MARKETPLACE</p><h1>{title}</h1><p>{description}</p></div>
      <Icon className="discovery-hero-icon" strokeWidth={1.2} aria-hidden />
    </header>
    <Suspense fallback={<div className="route-loading" role="status"><LoaderCircle size={23} aria-hidden /><p>Loading {title.toLowerCase()}…</p></div>}>
    {page === 'discover' && <Discover market={market} />}
    {page === 'deals' && <Deals market={market} />}
    {page === 'group-buy' && <Groups market={market} />}
    {page === 'coupons' && <Coupons market={market} />}
    {page === 'rewards' && <Rewards market={market} />}
    </Suspense>
  </div>;
}

async function Discover({ market }: { market: Market }) {
  const products = (await catalogSample(market)).slice(0, 8);
  return <>
    <ShoppingHistory market={market} />
    <ProductWatchlist market={market} />
    <section className="discovery-section" aria-label="Explore the catalog">
      <div className="market-section-heading"><div><p className="eyebrow">EXPLORE THE CATALOG</p><h2>Fresh finds</h2></div>
        <Link className="text-link" href={marketHref(market, '/collections/new-arrivals')}>New arrivals <ArrowRight size={16} aria-hidden /></Link></div>
      {products.length ? <CatalogGrid products={products} market={market} /> : <div className="empty-state"><Sparkles aria-hidden /><h2>No products to show</h2><p>Choose a market to see its catalog.</p></div>}
    </section>
  </>;
}

async function Deals({ market }: { market: Market }) {
  const { sales } = campaigns(market);
  const now = Date.now();
  const active = sales.filter((campaign) => Date.parse(campaign.startsAt) <= now && now < Date.parse(campaign.endsAt));
  const featured = await mapLimited(active, 3, async (campaign) => {
    const products = await mapLimited(campaign.productSlugs, 4, (slug) => catalogProduct(market, slug));
    return { campaign, products: products.flatMap((product) => product ?? []) };
  });
  return <>
    {featured.map(({ campaign, products }) => products.length > 0 && <section key={campaign.id} className="market-offer-panel" aria-label={campaign.title}>
      <div><p className="eyebrow">SAMPLE FLASH CAMPAIGN</p><h2>{campaign.title}</h2><p>{campaign.description}</p>
        <CampaignClock campaign={campaign} /></div>
      <CatalogGrid products={products} market={market} />
    </section>)}
    <div className="market-section-heading"><div><p className="eyebrow">CURRENT CATALOG PRICES</p><h2>On sale</h2></div></div>
    <Link href={marketHref(market, '/collections/sale')} className="button button-primary">Browse sale products <ArrowRight size={17} aria-hidden /></Link>
  </>;
}

async function Groups({ market }: { market: Market }) {
  const { groups } = campaigns(market);
  const featured = await mapLimited(groups, 3, async (campaign) => {
    const products = await mapLimited(campaign.productSlugs, 4, (slug) => catalogProduct(market, slug));
    return { campaign, products: products.flatMap((product) => product ?? []) };
  });
  if (!featured.length) return <div className="empty-state"><Users aria-hidden /><h2>No group offers in this market</h2>
    <p>Browse the catalog or send a product link to a friend.</p><ShopLink market={market} /></div>;
  return featured.map(({ campaign, products }) => <section className="market-offer-panel" key={campaign.id} id={campaign.id} aria-label={campaign.title}>
    <div>
      <p className="eyebrow">SYNTHETIC DEVELOPMENT PREVIEW</p>
      <h2>{campaign.title}</h2><p>{campaign.description} Participation is stored on this device. Sample tiers have no effect on checkout prices.</p>
      <CampaignClock campaign={campaign} /><GroupProgress campaign={campaign} />
      <ShareLink path={marketHref(market, '/group-buy') + '#' + campaign.id} label="Copy sample invitation" />
    </div>
    <CatalogGrid products={products} market={market} />
  </section>);
}

async function Coupons({ market }: { market: Market }) {
  const { offers, unavailable } = await couponOffers(market);
  return <>
    {unavailable ? <p role="status" className="catalog-notice">Coupon offers are temporarily unavailable.</p> : <CouponWallet offers={offers} market={market} />}
    <Link href={marketHref(market, '/cart')} className="text-link">View your shopping bag <ArrowRight size={17} aria-hidden /></Link>
  </>;
}

function Rewards({ market }: { market: Market }) {
  const sample = fixturesEnabled();
  return <section className="market-offer-panel" aria-label="Membership and referrals">
    <div>
      <p className="eyebrow">{sample ? 'SYNTHETIC DEVELOPMENT PREVIEW' : 'MEMBERSHIP & REFERRALS'}</p>
      <h2>{sample ? 'Your rewards dashboard' : 'Rewards availability'}</h2>
      {sample ? <><p>Sample points and tiers illustrate the membership experience.</p>
        <div className="reward-balance"><strong>240</strong><span>Sample points</span></div>
        <progress value={240} max={500} aria-label="240 of 500 sample points towards Plus" />
        <ol className="group-tiers"><li><strong>Member</strong><span>Current sample tier</span></li><li><strong>Plus</strong><span>500 sample points</span></li><li><strong>Premier</strong><span>1,500 sample points</span></li></ol></>
        : <p>Points and referral rewards are currently unavailable in this market.</p>}
    </div>
    <div className="share-card"><Globe aria-hidden /><h3>Share GriipBuddy</h3><p>Send a link to this storefront.</p><ShareLink path={marketHref(market)} /></div>
  </section>;
}

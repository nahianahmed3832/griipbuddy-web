import { ArrowLeft, ArrowRight, Bell, ClipboardList, Globe2, Heart, LifeBuoy, MapPin, Package, RotateCcw, ShieldCheck, ShoppingBag, Truck, UserRound } from 'lucide-react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { apiConfigured } from '@/features/catalog/api';
import { marketHref, type Market } from '@/features/catalog/catalog';
import { WishlistPage } from '@/features/catalog/saved-products';
import { accountId, orderStatus, type Customer, type CustomerOrder } from './contracts';
import { AccountBagLink, AccountNotice, AddressesForm, AddressText, AuthForm, PreferencesForm, ProfileForm, ReturnForm, SecurityForms, SignOut } from './forms';
import { OrderPage } from '@/features/checkout/order-page';
import { currentAccount, ownOrders } from './session';

const navigation = [
  { id: '', label: 'Overview', icon: UserRound },
  { id: 'orders', label: 'Orders', icon: Package },
  { id: 'addresses', label: 'Saved addresses', icon: MapPin },
  { id: 'returns', label: 'Returns & refunds', icon: RotateCcw },
  { id: 'wishlist', label: 'Wishlist', icon: Heart },
  { id: 'profile', label: 'Personal information', icon: ClipboardList },
  { id: 'security', label: 'Security', icon: ShieldCheck },
  { id: 'preferences', label: 'Notifications', icon: Bell },
];

const orderTones: Record<string, 'progress' | 'attention' | 'complete' | 'closed'> = {
  'awaiting payment': 'attention', 'awaiting receipt review': 'attention', 'payment pending': 'attention',
  placed: 'progress', 'order placed': 'progress', confirmed: 'progress', processing: 'progress', packed: 'progress',
  dispatched: 'progress', shipped: 'progress', 'in transit': 'progress', 'out for delivery': 'progress',
  delivered: 'complete', completed: 'complete',
  cancelled: 'closed', canceled: 'closed', expired: 'closed', 'reservation expired': 'closed', returned: 'closed', refunded: 'closed',
};

function href(market: Market, page = '') {
  return marketHref(market, '/account' + (page ? '/' + page : ''));
}

function date(market: Market, value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  return new Intl.DateTimeFormat(market.locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value));
}

function orderTotal(order: CustomerOrder, market: Market) {
  return order.currency && order.total !== undefined
    ? new Intl.NumberFormat(market.locale, { style: 'currency', currency: order.currency }).format(order.total)
    : 'Total unavailable';
}

function OrderStatus({ status }: { status: string }) {
  const label = orderStatus(status);
  return <span className="account-chip account-status" data-tone={orderTones[label.toLowerCase()]}>{label}</span>;
}

function AccountFrame({ market, customer, tab, children }: { market: Market; customer: Customer; tab: string; children: ReactNode }) {
  return <div className="container account-page">
    <header className="account-heading">
      <div><Link className="back-link" href={marketHref(market)}><ArrowLeft size={15} aria-hidden /> Home</Link><h1>My account</h1></div>
      <span className="account-market"><Globe2 size={16} aria-hidden /><span>{market.name} · {market.currency}</span></span>
    </header>
    <div className="account-layout">
      <aside className="account-sidebar">
        <div className="account-identity"><span className="account-icon"><UserRound size={19} aria-hidden /></span><strong>{customer.name}</strong></div>
        <nav aria-label="Account navigation">
          {navigation.map(({ id, label, icon: Icon }) => <Link key={id} href={href(market, id)} aria-current={tab === id ? 'page' : undefined}>
            <Icon size={17} aria-hidden /><span>{label}</span>
          </Link>)}
        </nav>
        <SignOut market={market} />
      </aside>
      <div className="account-content"><AccountNotice />{children}</div>
    </div>
  </div>;
}

function AccountSection({ title, intro, action, children }: { title: string; intro?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="account-section">
    <div className="account-section-heading"><div><h2>{title}</h2>{intro && <p>{intro}</p>}</div>{action}</div>
    {children}
  </section>;
}

function ReadOnlyNotice({ children }: { children: ReactNode }) {
  return <p className="account-feedback">{children}</p>;
}

function OrderList({ orders, market }: { orders: CustomerOrder[]; market: Market }) {
  if (!orders.length) return <div className="account-empty"><span className="account-icon"><Package size={21} aria-hidden /></span><p>You have no orders available in your account.</p><Link className="text-link" href={marketHref(market)}>Continue shopping <ArrowRight size={15} aria-hidden /></Link></div>;
  return <ul className="account-orders">{orders.map((order) => {
    const itemCount = order.lines.reduce((sum, line) => sum + line.quantity, 0);
    const orderDate = date(market, order.date);
    return <li className="account-order-card" key={order.id}>
      <span className="account-icon"><Package size={20} aria-hidden /></span>
      <div className="account-order-copy">
        <h3><Link href={href(market, 'orders/' + order.id)}>Order {order.number}</Link></h3>
        {(orderDate || itemCount > 0) && <small>{[orderDate, itemCount > 0 && itemCount + (itemCount === 1 ? ' item' : ' items')].filter(Boolean).join(' · ')}</small>}
      </div>
      <div className="account-order-data"><OrderStatus status={order.status} /><strong>{orderTotal(order, market)}</strong></div>
      <ArrowRight className="account-order-arrow" size={17} aria-hidden />
    </li>;
  })}</ul>;
}

function AccountOverview({ customer, orders, market }: { customer: Customer; orders: CustomerOrder[]; market: Market }) {
  const featured = orders.find((order) => {
    const tone = orderTones[orderStatus(order.status).toLowerCase()];
    return tone === 'progress' || tone === 'attention';
  });
  const featuredTone = featured ? orderTones[orderStatus(featured.status).toLowerCase()] : undefined;
  const latestUpdate = featured?.history.at(-1);
  const updated = date(market, latestUpdate?.date);
  const recent = orders.filter((order) => order !== featured).slice(0, 3);
  const defaultAddress = customer.addresses.find((address) => address.id === customer.defaultAddress);
  const currentReturn = customer.returns.at(-1);

  return <>
    <section className="account-welcome"><h2>Hello, {customer.name.split(/\s/)[0] || 'there'}</h2></section>
    <div className="account-overview-grid">
      <section className="account-feature">
        <div className="account-feature-heading">
          <span className="account-icon"><Truck size={24} aria-hidden /></span>
          {featured && <OrderStatus status={featured.status} />}
        </div>
        {featured ? <>
          <h2><Link href={href(market, 'orders/' + featured.id)}>Order {featured.number}</Link></h2>
          {featured.lines[0] && <p>{featured.lines[0].name}{featured.lines.length > 1 ? ' +' + (featured.lines.length - 1) + ' more' : ''}</p>}
          <div className="account-feature-footer">
            <Link className="button account-feature-action" href={href(market, 'orders/' + featured.id)}>
              {featuredTone === 'attention' ? 'View order' : 'Track order'} <ArrowRight size={16} aria-hidden />
            </Link>
            {updated && <small>Last updated {updated}</small>}
          </div>
        </> : <>
          <h2>No orders in progress</h2>
          <p>Once you place an order, you can follow its progress here.</p>
          <div className="account-feature-footer"><Link className="button account-feature-action" href={orders.length ? href(market, 'orders') : marketHref(market)}>
            {orders.length ? 'View order history' : 'Continue shopping'} <ArrowRight size={16} aria-hidden />
          </Link></div>
        </>}
      </section>
      <section className="account-overview-summary">
        <div className="account-summary-heading"><span className="account-icon"><MapPin size={20} aria-hidden /></span><h2>Saved addresses</h2></div>
        {defaultAddress ? <div className="account-address-preview"><strong>{defaultAddress.label}</strong><AddressText address={defaultAddress} /></div> : <p>{customer.addresses.length ? 'Choose a default address for your next order.' : 'Save a delivery address for your next order.'}</p>}
        <Link className="text-link" href={href(market, 'addresses')}>{customer.addresses.length ? 'Manage addresses' : 'Add an address'} <ArrowRight size={15} aria-hidden /></Link>
        {currentReturn && <Link className="account-return-preview" href={href(market, 'returns')}><RotateCcw size={16} aria-hidden /><span>Pending {currentReturn.kind} request</span><ArrowRight size={15} aria-hidden /></Link>}
      </section>
    </div>
    {recent.length > 0 && <AccountSection title={featured ? 'Previous orders' : 'Recent orders'} action={<Link className="text-link" href={href(market, 'orders')}>All orders <ArrowRight size={15} aria-hidden /></Link>}>
      <OrderList orders={recent} market={market} />
    </AccountSection>}
    <div className="account-quick-links">
      <div><span className="account-icon"><ShoppingBag size={18} aria-hidden /></span><AccountBagLink market={market} /></div>
      <div><span className="account-icon"><Heart size={18} aria-hidden /></span><Link className="text-link" href={href(market, 'wishlist')}>View wishlist <ArrowRight size={15} aria-hidden /></Link></div>
      <div><span className="account-icon"><LifeBuoy size={18} aria-hidden /></span><Link className="text-link" href={href(market, 'returns')}>Help with an order <ArrowRight size={15} aria-hidden /></Link></div>
    </div>
  </>;
}

function OrderDetail({ order, market, fixture }: { order: CustomerOrder; market: Market; fixture: boolean }) {
  return <>
    <AccountSection title={'Order ' + order.number} intro={date(market, order.date) || undefined} action={<Link className="text-link" href={href(market, 'orders')}><ArrowLeft size={15} aria-hidden /> All orders</Link>}>
      <div className="account-order-summary"><OrderStatus status={order.status} /><strong>{orderTotal(order, market)}</strong></div>
      <ul className="account-order-lines">{order.lines.map((line, index) => <li key={(line.sku ?? line.name) + ':' + index}>
        <div><strong>{line.name}</strong>{line.sku && <small>SKU {line.sku}</small>}</div>
        <span>Quantity {line.quantity}</span>
      </li>)}</ul>
    </AccountSection>
    <AccountSection title="Order tracking">
      {order.tracking && <p>Tracking code <strong>{order.tracking}</strong></p>}
      <ol className="account-tracking">{(order.history.length ? order.history : [{ status: order.status }]).map((event, index) =>
        <li key={index}><span>{orderStatus(event.status)}</span>{date(market, event.date) && <small>{date(market, event.date)}</small>}</li>)}</ol>
      {fixture && order.status === 'DELIVERED' && <Link className="text-link" href={href(market, 'returns') + '?order=' + encodeURIComponent(order.id)}>Request a return or refund</Link>}
    </AccountSection>
  </>;
}

export async function CustomerPage({ market, path, login = false, requestedOrder }: {
  market: Market; path: string[]; login?: boolean; requestedOrder?: string;
}) {
  const account = await currentAccount();
  const tab = path[0] ?? '';
  const initial = login ? 'login' : tab === 'register' ? 'register' : tab === 'recover' ? 'recover' : undefined;
  if (initial) {
    if (path.length > 1) notFound();
    if (account) redirect(href(market));
    return <div className="container account-auth">
      <div className="account-auth-aside">
        <p className="eyebrow">THE GRIIPBUDDY ACCOUNT</p>
        <h2>Everything you carry, together.</h2>
        <p>Keep track of orders, save your favourites and pick up where you left off.</p>
        <div><ShoppingBag size={19} aria-hidden /> Shopping bag <Heart size={19} aria-hidden /> Wishlist <Package size={19} aria-hidden /> Orders</div>
      </div>
      <AuthForm key={initial} initial={initial} market={market} fixture={!apiConfigured()} />
    </div>;
  }
  if (!navigation.some((item) => item.id === tab) || path.length > 2 || (path.length === 2 && tab !== 'orders')) notFound();
  if (!account) redirect(marketHref(market, '/login'));
  const customer = account.profile;
  const fixture = account.mode === 'fixture';
  const orders = tab === '' || tab === 'orders' || tab === 'returns' ? await ownOrders(account) : [];
  const order = path[1] && accountId(path[1]) ? orders.find((item) => item.id === path[1]) : undefined;
  if (path.length === 2 && !order) notFound();
  if (order?.syntheticCheckout) return <OrderPage id={order.id} market={market} fromAccount />;
  const eligible = orders.filter((item) => item.status === 'DELIVERED' && !customer.returns.some((request) => request.orderId === item.id));
  let content: ReactNode;

  switch (tab) {
    case '':
      content = <AccountOverview customer={customer} orders={orders} market={market} />;
      break;
    case 'orders':
      content = order ? <OrderDetail order={order} market={market} fixture={fixture} />
        : <AccountSection title="Order history" intro="Review orders and their latest recorded status."><OrderList orders={orders} market={market} /></AccountSection>;
      break;
    case 'profile':
      content = <AccountSection title="Personal information" intro="Your verified phone is used to identify your account.">
        {fixture ? <ProfileForm customer={customer} /> : <>
          <dl className="account-profile-list"><dt>Full name</dt><dd>{customer.name}</dd><dt>Phone</dt><dd>{customer.phone}</dd><dt>Email</dt><dd>{customer.email || 'No email saved'}</dd></dl>
          <ReadOnlyNotice>Profile editing is unavailable for this account.</ReadOnlyNotice>
        </>}
      </AccountSection>;
      break;
    case 'addresses':
      content = <AccountSection title="Saved addresses" intro="Choose the default address for future deliveries.">
        {fixture ? <AddressesForm customer={customer} /> : <>
          <div className="account-address-grid">{customer.addresses.map((address) => <div className="account-address" key={address.id}>
            <div><h3>{address.label}</h3>{customer.defaultAddress === address.id && <span className="account-chip">Default</span>}</div><AddressText address={address} />
          </div>)}</div>
          <ReadOnlyNotice>Address editing is unavailable for this account.</ReadOnlyNotice>
        </>}
      </AccountSection>;
      break;
    case 'wishlist':
      content = <AccountSection title="Wishlist" intro={'Saved products for ' + market.name + '.'}><WishlistPage market={market} /></AccountSection>;
      break;
    case 'security':
      content = <AccountSection title="Password and security" intro={'Verified phone · ' + customer.phone}>
        {fixture ? <SecurityForms customer={customer} market={market} /> : <ReadOnlyNotice>Password changes and email verification are unavailable for this account.</ReadOnlyNotice>}
      </AccountSection>;
      break;
    case 'preferences':
      content = <AccountSection title="Notification preferences" intro="Choose which messages you would like to receive.">
        {fixture ? <PreferencesForm customer={customer} /> : <ReadOnlyNotice>Notification preferences are unavailable for this account.</ReadOnlyNotice>}
      </AccountSection>;
      break;
    default:
      content = <AccountSection title="Returns & refunds" intro="Review requests associated with your orders.">
        {fixture ? <>
          {customer.returns.length > 0 && <ul className="account-return-list">{customer.returns.map((request) => <li key={request.id}>
            <strong>{request.kind === 'return' ? 'Return' : 'Refund'} request</strong>
            <span>Order {orders.find((item) => item.id === request.orderId)?.number}</span><span className="account-chip">Pending</span>
          </li>)}</ul>}
          <ReturnForm orders={eligible} orderId={eligible.some((item) => item.id === requestedOrder) ? requestedOrder : undefined} />
        </> : <ReadOnlyNotice>Online return requests are unavailable for this account. <Link className="text-link" href={marketHref(market, '/contact-and-support')}>Contact support</Link></ReadOnlyNotice>}
      </AccountSection>;
  }
  return <AccountFrame market={market} customer={customer} tab={tab}>{content}</AccountFrame>;
}

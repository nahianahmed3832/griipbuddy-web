import { ArrowLeft, ArrowRight, Bell, ClipboardList, Heart, MapPin, Package, RotateCcw, ShieldCheck, ShoppingBag, UserRound } from 'lucide-react';
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
  { id: 'profile', label: 'Personal information', icon: ClipboardList },
  { id: 'addresses', label: 'Saved addresses', icon: MapPin },
  { id: 'wishlist', label: 'Wishlist', icon: Heart },
  { id: 'security', label: 'Security', icon: ShieldCheck },
  { id: 'returns', label: 'Returns & refunds', icon: RotateCcw },
  { id: 'preferences', label: 'Notifications', icon: Bell },
];

function href(market: Market, page = '') {
  return marketHref(market, '/account' + (page ? '/' + page : ''));
}

function date(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value));
}

function orderTotal(order: CustomerOrder, market: Market) {
  return order.currency && order.total !== undefined
    ? new Intl.NumberFormat(market.locale, { style: 'currency', currency: order.currency }).format(order.total)
    : 'Total unavailable';
}

function AccountFrame({ market, customer, tab, children }: { market: Market; customer: Customer; tab: string; children: ReactNode }) {
  return <div className="container account-page">
    <Link className="back-link" href={marketHref(market)}><ArrowLeft size={16} aria-hidden /> Home</Link>
    <div className="account-heading">
      <div><p className="eyebrow">YOUR GRIIPBUDDY</p><h1>My account</h1></div>
      <div><span>{customer.name}</span><small>{market.name} · {market.currency}</small></div>
    </div>
    <div className="account-layout">
      <aside className="account-sidebar">
        <nav aria-label="Account navigation">
          {navigation.map(({ id, label, icon: Icon }) => <Link key={id} href={href(market, id)} aria-current={tab === id ? 'page' : undefined}>
            <Icon size={16} aria-hidden />{label}
          </Link>)}
        </nav>
        <SignOut market={market} />
      </aside>
      <div className="account-content"><AccountNotice />{children}</div>
    </div>
  </div>;
}

function AccountSection({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  return <section className="account-section">
    <div className="account-section-heading"><h2>{title}</h2>{intro && <p>{intro}</p>}</div>
    {children}
  </section>;
}

function ReadOnlyNotice({ children }: { children: ReactNode }) {
  return <p className="account-feedback">{children}</p>;
}

function OrderList({ orders, market }: { orders: CustomerOrder[]; market: Market }) {
  if (!orders.length) return <div className="account-empty"><Package size={25} aria-hidden /><p>You have no orders available in your account.</p></div>;
  return <ul className="account-orders">{orders.map((order) => <li key={order.id}>
    <div><Link href={href(market, 'orders/' + order.id)}>Order {order.number}</Link>
      <small>{date(order.date) || order.lines.reduce((sum, line) => sum + line.quantity, 0) + ' items'}</small></div>
    <span className="account-chip">{orderStatus(order.status)}</span>
    <span className="account-order-total">{orderTotal(order, market)}</span>
    <Link className="icon-button" href={href(market, 'orders/' + order.id)} aria-label={'View order ' + order.number}><ArrowRight size={17} aria-hidden /></Link>
  </li>)}</ul>;
}

function OrderDetail({ order, market, fixture }: { order: CustomerOrder; market: Market; fixture: boolean }) {
  return <>
    <AccountSection title={'Order ' + order.number} intro={date(order.date) || undefined}>
      <Link className="back-link" href={href(market, 'orders')}><ArrowLeft size={15} aria-hidden /> All orders</Link>
      <div className="account-order-summary"><span className="account-chip">{orderStatus(order.status)}</span><strong>{orderTotal(order, market)}</strong></div>
      <ul className="account-order-lines">{order.lines.map((line, index) => <li key={(line.sku ?? line.name) + ':' + index}>
        <div><strong>{line.name}</strong>{line.sku && <small>SKU {line.sku}</small>}</div>
        <span>Quantity {line.quantity}</span>
      </li>)}</ul>
    </AccountSection>
    <AccountSection title="Order tracking">
      {order.tracking && <p>Tracking code <strong>{order.tracking}</strong></p>}
      <ol className="account-tracking">{(order.history.length ? order.history : [{ status: order.status }]).map((event, index) =>
        <li key={index}><span>{orderStatus(event.status)}</span>{date(event.date) && <small>{date(event.date)}</small>}</li>)}</ol>
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
  if (order?.syntheticCheckout) return <OrderPage id={order.id} market={market} />;
  const eligible = orders.filter((item) => item.status === 'DELIVERED' && !customer.returns.some((request) => request.orderId === item.id));
  let content: ReactNode;

  switch (tab) {
    case '':
      content = <>
        <AccountSection title={'Hello, ' + (customer.name.split(/\s/)[0] || 'there')} intro="Manage your orders, saved products and personal information.">
          <div className="account-overview-grid">
            <div><Package size={21} aria-hidden /><h3>Orders</h3><Link className="text-link" href={href(market, 'orders')}>View order history</Link></div>
            <div><ShoppingBag size={21} aria-hidden /><h3>Shopping bag</h3><AccountBagLink market={market} /></div>
            <div><Heart size={21} aria-hidden /><h3>Wishlist</h3><Link className="text-link" href={href(market, 'wishlist')}>View saved products</Link></div>
          </div>
        </AccountSection>
        <AccountSection title="Recent orders"><OrderList orders={orders.slice(0, 3)} market={market} /></AccountSection>
      </>;
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
            <h3>{address.label}</h3><AddressText address={address} />
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

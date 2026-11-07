import Link from 'next/link';
import { marketHref, type CatalogProduct, type Market } from './catalog';

export function DeliveryDetails({ product, market }: { product: CatalogProduct; market: Market }) {
  const delivery = product.delivery;
  return <details className="detail-accordion product-delivery">
    <summary>Delivery &amp; returns</summary>
    <dl>
      <div><dt>Browsing market</dt><dd>{market.name}</dd></div>
      {delivery?.origin && <div><dt>Dispatch origin</dt><dd>{delivery.origin}</dd></div>}
      {product.deliveryEstimate && <div><dt>Delivery estimate</dt><dd>{product.deliveryEstimate}</dd></div>}
      {delivery?.customs && <div><dt>Customs &amp; duties</dt><dd>{delivery.customs}</dd></div>}
      {delivery?.consolidation && <div><dt>Parcel consolidation</dt><dd>{delivery.consolidation}</dd></div>}
    </dl>
    <p>See delivery eligibility and any available quote in your bag.</p>
    <div><Link className="text-link" href={marketHref(market, '/shipping-procedure')}>Shipping information</Link>
      <Link className="text-link" href={marketHref(market, '/returns-and-exchange')}>Returns &amp; exchanges</Link></div>
  </details>;
}

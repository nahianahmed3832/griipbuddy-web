import Image from 'next/image';
import Link from 'next/link';
import { ArrowUpRight, ImageIcon } from 'lucide-react';
import { lowestPricedVariant } from './browse';
import { attribute, currentPrice, formatMoney, productBadges, productHref, type CatalogProduct, type Market } from './catalog';
import { WishlistButton } from './wishlist';

export function ProductCard({ product, market, priority = false, linkVariant = false }: {
  product: CatalogProduct; market: Market; priority?: boolean; linkVariant?: boolean;
}) {
  const variant = lowestPricedVariant(product.variants);
  const price = variant?.price;
  const colors = [...new Set(product.variants.flatMap((entry) => attribute(entry, 'color') ?? attribute(entry, 'colour') ?? []))];
  const image = variant?.images[0] ?? product.images[0];
  const href = productHref(market, product.slug) + (linkVariant && variant ? '?variant=' + encodeURIComponent(variant.id) : '');
  const hasRange = product.variants.some((entry) => entry.price && price && currentPrice(entry.price) !== currentPrice(price));
  return (
    <article className="product-card">
      <div className="product-image">
        <Link href={href} aria-label={'View ' + product.name}>
          {image
            ? <Image src={image} alt={product.name} fill priority={priority} unoptimized={image.startsWith('https://')}
              referrerPolicy="no-referrer" sizes="(max-width: 650px) 46vw, (max-width: 1000px) 31vw, 23vw" />
            : <span className="catalog-image-empty"><ImageIcon aria-hidden size={28} /><span>Image unavailable</span></span>}
        </Link>
        <div className="product-badges">
          {productBadges(product).map((badge) => <span className="product-badge" data-badge={badge} key={badge}>{badge}</span>)}
        </div>
        <WishlistButton slug={product.slug} name={product.name} />
      </div>
      <div className="product-copy">
        {product.brand && <p className="product-brand">{product.brand.name}</p>}
        <h3><Link href={href}>{product.name}</Link></h3>
        {colors.length > 0 && <p className="product-color">{colors.length === 1 ? colors[0] : colors.length + ' colors'}</p>}
        <div className="product-card-bottom">
        {price && <p className="product-price">
          {hasRange && <span className="price-from">From </span>}{formatMoney(currentPrice(price), market)}
          {price.sale !== undefined && <del aria-label={'Regular price ' + formatMoney(price.regular, market)}>{formatMoney(price.regular, market)}</del>}
        </p>}
        <Link href={href} className="product-card-action" aria-label={'Choose options for ' + product.name}><ArrowUpRight size={17} aria-hidden /></Link>
        </div>
        {Boolean(product.sold && product.sold > 0) && <small className="product-sold">{new Intl.NumberFormat(market.locale).format(product.sold!)} sold</small>}
      </div>
    </article>
  );
}

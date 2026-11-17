import { marketStoreHref } from "@/config/regional-path";
import Link from "next/link";
import { formatMoney, type Market, type MarketId } from "@/config/markets";
import { discountPercentage, type ProductCardData } from "@/lib/catalog/listing";
import type { CardActivity } from "@/lib/catalog/card-activity";
import { FavoriteButton } from "./marketplace/favorites";
import { CatalogPhoto } from "./catalog-photo";

export function productHref(card: Pick<ProductCardData, "slug" | "variantId">, market?: MarketId): string {
  const query = new URLSearchParams({ variant: card.variantId });
  return marketStoreHref(`/products/${encodeURIComponent(card.slug)}?${query}`, market);
}

export function ProductGrid({ cards, market, preview, activity, regional }: {
  cards: readonly ProductCardData[]; market: Market; preview?: boolean; activity?: Readonly<Record<string, CardActivity>>; regional?: boolean;
}) {
  return (
    <ul className="product-grid">
      {cards.map((card) => {
        const discount = card.inStock && card.shop ? discountPercentage(card) : 0;
        const details = activity?.[card.id];
        const rating = details?.rating;
        return (
        <li key={card.id} className={card.shop ? "mp-listing-card" : undefined}>
          <Link className="product-card" href={preview ? "#product-preview" : productHref(card, regional ? market.id : undefined)} prefetch={!preview && !card.shop}>
            <div className="product-card__image">
              <CatalogPhoto image={card.image} responsive={regional} rendition="card" fill
                sizes={regional ? "(max-width: 730px) calc((100vw - 42px) / 2), 240px" : "(max-width: 639px) 50vw, (max-width: 989px) 33vw, 340px"} />
              {!card.inStock && <span className="product-card__badge">Out of stock</span>}
              {discount > 0 && <span className="mp-offer-percent">{discount}% off</span>}
            </div>
            <h3>{card.name}</h3>
            {card.shop && <p className="mp-shop-name">{card.shop.name}</p>}
            <p className="product-card__price">{card.multiplePrices && <span>From </span>}{formatMoney(card.priceMinor, market)}
              {card.shop && card.regularMinor && card.regularMinor > card.priceMinor && <del>{formatMoney(card.regularMinor, market)}</del>}</p>
            {rating && <p className="mp-card-rating">
              <span aria-hidden="true">★ {rating.average.toFixed(1)} <span className="mp-card-rating-count">({rating.count})</span></span>
              <span className="sr-only">{rating.average.toFixed(1)} out of 5, {rating.count} {rating.count === 1 ? "review" : "reviews"}</span>
            </p>}
            {card.shop && card.stock > 0 && card.stock <= 5 && <p className="mp-card-low-stock">Only {card.stock} left</p>}
            {!!details?.recentUnits && <p className="mp-card-sold">{details.recentUnits.toLocaleString(market.locale)} sold in 30 days</p>}
            {!details?.recentUnits && !!details?.demoUnits && <p className="mp-card-sold">{details.demoUnits.toLocaleString(market.locale)} sold in demo</p>}
          </Link>
          {card.shop && !preview && <FavoriteButton product={card.id} name={card.name}/>}
        </li>
        );
      })}
    </ul>
  );
}

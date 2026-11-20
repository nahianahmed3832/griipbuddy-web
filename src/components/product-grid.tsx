import Image from "next/image";
import { storefrontPath } from "@/config/storefront-path";
import { formatMoney, type Market } from "@/config/markets";
import { productLandingPath } from "@/config/regional-path";
import { discountPercentage, type ProductCardData } from "@/lib/catalog/listing";
import type { CardActivity } from "@/lib/catalog/card-activity";
import { FavoriteButton } from "./marketplace/favorites";
import { MeasuredProductLink, type Placement } from "./measurement-observers";

export function productHref(card: Pick<ProductCardData, "slug" | "variantId">): string {
  return `/products/${card.slug}?variant=${card.variantId}`;
}

export function savedParentHref(slug: string, market: Market, regional: boolean): string {
  return marketProductHref(slug, market, regional);
}

export function marketProductHref(slug: string, market: Market, regional: boolean, variantId?: string): string {
  const [path, query] = productLandingPath(slug, market.id, regional, variantId).split("?");
  const params = new URLSearchParams(query);
  params.set("browse", "1");
  params.set("lang", market.locale);
  return `${path}?${params}`;
}

export function ProductGrid({ cards, market, preview, activity, placement = { placement: "product-grid" }, offset = 0, savedParents,
  linkForCard = productHref, presentation }: {
  cards: readonly ProductCardData[]; market: Market; preview?: boolean; activity?: Readonly<Record<string, CardActivity>>;
  placement?: Placement; offset?: number; savedParents?: { regional: boolean; favorites?: boolean };
  linkForCard?: (card: ProductCardData) => string;
  presentation?: "home";
}) {
  const home = presentation === "home";
  return (
    <ul className="product-grid">
      {cards.map((card, index) => {
        const compare = (home ? Boolean(card.promotion) : Boolean(card.shop)) &&
          card.regularMinor !== undefined && card.regularMinor > card.priceMinor;
        const discount = card.inStock && compare ? discountPercentage(card) : 0;
        const details = activity?.[card.id];
        const rating = details?.rating;
        const href = savedParents ? savedParentHref(card.slug, market, savedParents.regional) : linkForCard(card);
        return (
        <li key={card.id} className={card.shop || savedParents?.favorites ? "mp-listing-card" : undefined}>
          <MeasuredProductLink card={savedParents ? { id: card.id, priceMinor: card.priceMinor } : card} market={market}
            context={{ ...placement, position: offset + index + 1 }} preview={preview}
            className="product-card" href={preview ? "#product-preview" : href} prefetch={!home && !preview && !card.shop}>
            <div className="product-card__image">
              <Image src={storefrontPath(card.image.src)} alt={card.image.alt} fill sizes={home
                ? "(max-width: 650px) 48vw, (max-width: 1024px) 33vw, 410px"
                : "(max-width: 639px) 50vw, (max-width: 989px) 33vw, 340px"} />
              {!card.inStock && <span className="product-card__badge">Out of stock</span>}
              {discount > 0 && <span className="mp-offer-percent">{discount}% off</span>}
            </div>
            <h3>{card.name}</h3>
            {card.shop && <p className="mp-shop-name">{card.shop.name}</p>}
            <p className="product-card__price">{card.multiplePrices && <span>From </span>}{formatMoney(card.priceMinor, market)}
              {compare && card.regularMinor !== undefined && <del>{formatMoney(card.regularMinor, market)}</del>}</p>
            {savedParents && <p className="mp-shop-name">Choose options</p>}
            {rating && <p className="mp-card-rating">
              <span aria-hidden="true">★ {rating.average.toFixed(1)} <span className="mp-card-rating-count">({rating.count})</span></span>
              <span className="sr-only">{rating.average.toFixed(1)} out of 5, {rating.count} {rating.count === 1 ? "review" : "reviews"}</span>
            </p>}
            {!home && card.shop && card.stock > 0 && card.stock <= 5 && <p className="mp-card-low-stock">Only {card.stock} left</p>}
            {!!details?.recentUnits && <p className="mp-card-sold">{details.recentUnits.toLocaleString(market.locale)} sold in 30 days</p>}
            {!details?.recentUnits && !!details?.demoUnits && <p className="mp-card-sold">{details.demoUnits.toLocaleString(market.locale)} sold in demo</p>}
          </MeasuredProductLink>
          {(card.shop || savedParents?.favorites) && !preview && <FavoriteButton product={card.id} name={card.name}
            market={market} variantId={savedParents ? undefined : card.variantId} priceMinor={card.priceMinor} />}
        </li>
        );
      })}
    </ul>
  );
}

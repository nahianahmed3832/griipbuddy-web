import 'server-only';
import { catalogGet, objectId } from './api';
import { approvedCatalogImage } from './media';
import { storefrontExtrasEnabled } from './merchandising';

export type ReviewMedia = { type: 'image' | 'video'; src: string };
export type Review = { id: string; rating: number; title?: string; content: string; createdAt: string; verified: boolean; media: ReviewMedia[] };
export type ReviewPage = { ratings: number[]; reviews: Review[] };
export type Eligible = { reviewed: boolean; orders: { id: string; number?: string; date: string }[] };

type SourceReview = {
  _id: string; rating: number; title?: string; content: string; createdAt: string; verifiedPurchase?: boolean;
  media?: { type: string; url: string }[]; storefrontMediaTypes?: string[];
};

export async function publicReviews(id: string, sort = 'recent', page = 1): Promise<ReviewPage> {
  if (!objectId(id) || !storefrontExtrasEnabled()) throw new Error('Reviews unavailable');
  const { ratings, entries } = await catalogGet('/storefront-reviews/product/' + id,
    new URLSearchParams({ sort, page: String(page) })) as { ratings: { _id: number; count: number }[]; entries: SourceReview[] };
  return {
    ratings: [1, 2, 3, 4, 5].map(rating => ratings.find(row => row._id === rating)?.count ?? 0),
    reviews: entries.flatMap(row => {
      if (!objectId(row._id)) return [];
      const media: ReviewMedia[] = (row.storefrontMediaTypes ?? []).map((type, index) => ({
        type: type === 'video/mp4' ? 'video' : 'image', src: '/api/reviews/media?id=' + row._id + '&index=' + index,
      }));
      for (const file of (row.media ?? []).slice(0, 4)) {
        if ((file.type === 'image' || file.type === 'video') && approvedCatalogImage(file.url)) {
          media.push({ type: file.type, src: file.url });
        }
      }
      return [{ id: row._id, rating: row.rating, title: row.title, content: row.content,
        createdAt: row.createdAt, verified: row.verifiedPurchase === true, media }];
    }),
  };
}

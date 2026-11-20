import { notFound } from "next/navigation";
import { CouponDirectory } from "@/components/marketplace/coupon-directory";
import { currentMarket } from "@/lib/market-server";
import { marketplaceMode } from "@/lib/release-config";

export const metadata = { title: "Coupons" };

export default async function PublicCoupons() {
  if (!marketplaceMode()) notFound();
  return <div className="shell mp-page"><CouponDirectory market={await currentMarket()}/></div>;
}

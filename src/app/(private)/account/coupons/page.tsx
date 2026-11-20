import Link from "next/link";
import { notFound } from "next/navigation";
import { CouponDirectory } from "@/components/marketplace/coupon-directory";
import { SignInGate } from "@/components/marketplace/session";
import { currentMarket } from "@/lib/market-server";
import { getShopper } from "@/lib/marketplace/auth";
import { marketplaceMode } from "@/lib/release-config";

export const metadata = { title: "Your market coupons", robots: { index: false, follow: false } };

export default async function AccountCoupons() {
  if (!marketplaceMode()) notFound();
  const shopper = await getShopper();
  if (!shopper) return <div className="shell mp-page"><h1>Coupons</h1><SignInGate>Sign in to open your account.</SignInGate></div>;
  return <div className="shell mp-page">
    <p><Link href="/account">Account overview</Link></p>
    <CouponDirectory market={await currentMarket()}/>
  </div>;
}

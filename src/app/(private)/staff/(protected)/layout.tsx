import Link from "next/link";
import type { ReactNode } from "react";
import { StaffSignOut } from "@/components/staff-sign-out";
import { mainAdminCatalogRequested } from "@/lib/catalog/main-admin-config";
import { requireStaff } from "@/lib/staff/access";
import { staffMarketIds } from "@/lib/staff/market-access";
import { marketplaceMode } from "@/lib/release-config";

export default async function StaffLayout({ children }: { children: ReactNode }) {
  const staff = await requireStaff();
  const [homepageMarkets, reportingMarkets, commercialMarkets] = await Promise.all([
    staffMarketIds(staff.id, "merchandising"), staffMarketIds(staff.id, "reporting"), staffMarketIds(staff.id, "commercial"),
  ]);
  const catalogInMainAdmin = mainAdminCatalogRequested();
  return (
    <div className="shell inner-page commerce-page staff-area">
      <div className="staff-toolbar">
        <nav aria-label="Staff navigation">
          <Link href="/staff">Orders</Link>
          {homepageMarkets.length > 0 && <Link href="/staff/homepage">Homepage</Link>}
          {!catalogInMainAdmin && homepageMarkets.length > 0 && staff.role !== "OWNER" && <Link href="/staff/catalog/taxonomy">Catalog organization</Link>}
          {!catalogInMainAdmin && commercialMarkets.length > 0 && staff.role !== "OWNER" && <Link href="/staff/catalog">Catalog offers</Link>}
          {reportingMarkets.length > 0 && <><Link href="/staff/acquisition">Acquisition</Link><Link href="/staff/intelligence">Product Intelligence</Link>
            <Link href="/staff/workflows">Workflow Center</Link></>}
          {staff.role === "OWNER" && <>
            <Link href="/staff/cod-reconciliation">COD reconciliation</Link>
            {!catalogInMainAdmin && <><Link href="/staff/catalog">Catalog</Link>
              <Link href="/staff/catalog/inventory">Inventory and prices</Link></>}
            <Link href="/staff/settings">Market settings</Link>
            {marketplaceMode() && <Link href="/staff/marketplace">Marketplace</Link>}
            {marketplaceMode() && <Link href="/staff/coupons">Coupons</Link>}
            {marketplaceMode() && <Link href="/staff/cases">Order cases</Link>}
          </>}
        </nav>
        <div>
          <span>{staff.name} · {staff.role === "OWNER" ? "Owner" : "Packer"}</span>
          <StaffSignOut />
        </div>
      </div>
      {children}
    </div>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";
import { StaffSignOut } from "@/components/staff-sign-out";
import { shopperMailPreview } from "@/lib/commerce/shopper-mail";
import { requireStaff } from "@/lib/staff/access";
import { marketplaceMode } from "@/lib/release-config";

export default async function StaffLayout({ children }: { children: ReactNode }) {
  const staff = await requireStaff();
  return (
    <div className="shell inner-page commerce-page staff-area">
      <div className="staff-toolbar">
        <nav aria-label="Staff navigation">
          <Link href="/staff">Orders</Link>
          {staff.role === "OWNER" && <>
            <Link href="/staff/cod-reconciliation">COD reconciliation</Link>
            <Link href="/staff/catalog">Catalog</Link>
            <Link href="/staff/catalog/inventory">Inventory and prices</Link>
            <Link href="/staff/settings">Market settings</Link>
            <Link href="/staff/acquisition">Acquisition</Link>
            {marketplaceMode() && <Link href="/staff/marketplace">Marketplace</Link>}
            {marketplaceMode() && <Link href="/staff/coupons">Coupons</Link>}
            {marketplaceMode() && <Link href="/staff/cases">Order cases</Link>}
            {shopperMailPreview() && <Link href="/staff/test-email">Test email</Link>}
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

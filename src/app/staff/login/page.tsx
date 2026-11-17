import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { StaffLogin } from "@/components/staff-login";
import { getStaff } from "@/lib/staff/access";

export const metadata: Metadata = { title: "Staff sign-in" };

export default async function StaffLoginPage() {
  if (await getStaff()) redirect("/staff");
  return (
    <div className="shell inner-page commerce-page staff-login">
      <div className="commerce-intro">
        <h1 className="display-type">Staff sign-in</h1>
        <p>For GriipBuddy owners and packing staff.</p>
      </div>
      <StaffLogin />
    </div>
  );
}

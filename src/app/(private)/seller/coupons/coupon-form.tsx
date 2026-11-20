"use client";

import { useActionState } from "react";
import { changeSellerCoupon } from "./actions";

export function SellerCouponForm({ marketId, currency, code }: {
  marketId: string; currency: string; code?: string;
}) {
  const [state, submit, pending] = useActionState(changeSellerCoupon.bind(null, marketId), {});
  return <form action={submit} className={code ? undefined : "seller-filters"} aria-label={code ? `Manage ${code}` : "Create seller coupon"}>
    {code ? <>
      <input type="hidden" name="code" value={code}/>
      <button type="submit" name="action" value="disable" className="seller-button" disabled={pending}>
        Disable
      </button>
    </> : <>
      <label>Coupon code<input name="code" required minLength={3} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9\\-]{2,31}"/></label>
      <label>Discount type<select name="kind"><option value="FIXED">Fixed amount</option><option value="PERCENT">Percent</option></select></label>
      <label>Amount ({currency} or %)<input name="value" type="number" min="0.01" max="100000" step="0.01" required/></label>
      <label>Minimum shop subtotal ({currency})<input name="minimum" type="number" min="0" max="100000" step="0.01"/></label>
      <label>Order limit<input name="limit" type="number" min="1" max="100000" step="1"/></label>
      <label>Last day<input name="ends" type="date"/></label>
      <button className="seller-button seller-button-primary" type="submit" name="action" value="create" disabled={pending}>Create coupon</button>
    </>}
    {state.message && <p role={state.error ? "alert" : "status"}>{state.message}</p>}
  </form>;
}

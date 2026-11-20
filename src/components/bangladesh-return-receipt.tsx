import { receiveBangladeshRefusedParcelAction } from "@/app/staff/bangladesh-return-actions";
import type { BangladeshReturnDisposition, PaymentMethod } from "@/generated/prisma/enums";
import { orderDate } from "@/lib/commerce/labels";
import { StaffActionForm } from "./staff-actions";

type WarehouseReceipt = { receivedAt: Date; disposition: BangladeshReturnDisposition; restockedUnits: number; note: string };

export function BangladeshReturnReceiptPanel({ orderId, paymentMethod, receipt }: {
  orderId: string; paymentMethod: PaymentMethod; receipt: WarehouseReceipt | null;
}) {
  return (
    <section className="commerce-panel">
      <h2>Refused parcel return</h2>
      <p>{paymentMethod === "COD" ? "The shopper was not charged." : "Online payment is unchanged. Handle any refund separately."}</p>
      {receipt ? (
        <ul className="staff-history">
          <li>
            <strong>Received at warehouse</strong><span>{orderDate(receipt.receivedAt)}</span>
            <p>{receipt.disposition === "RESTOCK" ? `Restocked units: ${receipt.restockedUnits}` : "Held for review · No stock restored"}</p>
            <p className="whitespace-pre-wrap break-words">{receipt.note}</p>
          </li>
        </ul>
      ) : (
        <>
          <p>Awaiting warehouse receipt. Record the return after the parcel arrives and you inspect it.</p>
          <StaffActionForm action={receiveBangladeshRefusedParcelAction.bind(null, orderId)} submitLabel="Record warehouse receipt">
            <label>
              Stock decision
              <select name="disposition" defaultValue="" required>
                <option value="" disabled>Choose after inspection</option>
                <option value="RESTOCK">Restock all ordered items — complete and sellable</option>
                <option value="HOLD">Hold for review — missing, damaged or uncertain</option>
              </select>
            </label>
            <label>Warehouse note<textarea name="note" rows={3} minLength={3} maxLength={500} required /></label>
            <label className="commerce-option">
              <input type="checkbox" name="confirm" value="yes" required /> I received and inspected the physical parcel.
            </label>
          </StaffActionForm>
        </>
      )}
    </section>
  );
}

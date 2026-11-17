import { privateHeaders } from "@/lib/db/http";
import { getStaff } from "@/lib/staff/access";
import { OperationError, staffManualPaymentReceipt } from "@/lib/staff/operations";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const [staff, { id }] = await Promise.all([getStaff(), params]);
  if (staff?.role !== "OWNER") return new Response(null, { status: 404, headers: privateHeaders });
  try {
    const proof = await staffManualPaymentReceipt(staff.id, id);
    if (!proof?.receipt) return new Response(null, { status: 404, headers: privateHeaders });
    return new Response(proof.receipt, { headers: {
      ...privateHeaders, "Content-Type": "image/webp", "Content-Disposition": 'attachment; filename="payment-receipt.webp"',
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    return new Response(null, { status: 404, headers: privateHeaders });
  }
}

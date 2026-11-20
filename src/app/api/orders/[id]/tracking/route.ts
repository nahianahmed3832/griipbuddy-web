import type { NextRequest } from "next/server";
import { handleOrderTracking } from "@/lib/commerce/order-tracking-request";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleOrderTracking(request, (await params).id, "account");
}

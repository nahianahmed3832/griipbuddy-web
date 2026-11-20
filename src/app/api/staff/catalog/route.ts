import { revalidatePath } from "next/cache";
import { handleCatalogMutation } from "@/lib/catalog/admin-api";
import { currentMarket } from "@/lib/market-server";
import { getStaff } from "@/lib/staff/access";

export async function POST(request: Request) {
  const response = await handleCatalogMutation(request, {
    actor: async () => {
      const staff = await getStaff();
      return staff ? { kind: "staff", id: staff.id, role: staff.role } : null;
    },
    market: async () => (await currentMarket()).id,
  });
  if (response.ok) revalidatePath("/", "layout");
  return response;
}

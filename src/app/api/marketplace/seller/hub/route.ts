import { runSellerHubCommand } from "@/lib/marketplace/seller-hub";
import { sellerHubPost } from "@/lib/marketplace/seller-hub-http";

export function POST(request: Request) {
  return sellerHubPost(request, "hub", runSellerHubCommand);
}

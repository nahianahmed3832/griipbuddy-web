import { sellerHubPost } from "@/lib/marketplace/seller-hub-http";
import { runSellerTeamCommand } from "@/lib/marketplace/seller-team";

export function POST(request: Request) {
  return sellerHubPost(request, "team", runSellerTeamCommand);
}

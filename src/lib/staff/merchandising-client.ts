import { storefrontPath } from "../../config/storefront-path";
import type { Feedback } from "./merchandising-http";

export async function postMerchandising(form: FormData): Promise<Feedback> {
  try {
    const response = await fetch(storefrontPath("/api/staff/merchandising"), {
      method: "POST", body: form, headers: { "X-Griip-Merchandising": "1" },
    });
    return await response.json() as Feedback;
  } catch {
    return { error: "The request did not complete. Reload before retrying." };
  }
}

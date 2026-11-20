import { revalidatePath } from "next/cache";

// The regional homepage is rewritten to the same route. Resolved prices, stock
// and schedules are evaluated per request regardless of the rendered page cache.
export function invalidateHomepagePublication() {
  revalidatePath("/");
  revalidatePath("/api/storefront/homepage");
}

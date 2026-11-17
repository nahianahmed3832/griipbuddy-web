"use server";

import { revalidatePath } from "next/cache";
import { getStaff } from "@/lib/staff/access";
import { saveProduct } from "@/lib/staff/catalog";
import type { ProductInput } from "@/lib/staff/catalog-input";
import { OperationError } from "@/lib/staff/operations";
import { reportFailure } from "@/lib/db/observability";
import { saveTaxonomy } from "@/lib/staff/taxonomy";

export async function saveProductAction(product: ProductInput, revision: number | null) {
  const actor = await getStaff();
  if (actor?.role !== "OWNER") return { error: "Owner access is required." };
  try {
    const status = await saveProduct(actor.id, product, revision, "editor");
    revalidatePath("/", "layout");
    return { success: status === "Unchanged" ? "No changes to save." : "Product saved.", revision: status === "Unchanged" ? revision : revision === null ? 0 : revision + 1 };
  } catch (error) {
    if (error instanceof OperationError) return { error: error.message };
    reportFailure("staff.product-save", undefined, error);
    return { error: "The product could not be saved. Try again." };
  }
}

export async function saveTaxonomyAction(kind: "department" | "collection", existingId: string | null, _state: unknown, form: FormData) {
  const actor = await getStaff();
  if (actor?.role !== "OWNER") return { error: "Owner access is required." };
  const src = form.get("photo.src");
  const alt = form.get("photo.alt");
  const position = form.get("position");
  try {
    await saveTaxonomy(actor.id, {
      id: form.get("id"), slug: form.get("slug"), name: form.get("name"), kind,
      description: form.get("description"), position: typeof position === "string" && /^\d{1,4}$/.test(position) ? Number(position) : NaN,
      shortName: form.get("shortName"), selection: form.get("selection"), parentId: form.get("parentId") || null,
      image: src || alt ? { src, alt } : undefined,
    }, existingId);
    revalidatePath("/", "layout");
    return { success: "Saved." };
  } catch (error) {
    if (error instanceof OperationError) return { error: error.message };
    reportFailure("staff.taxonomy-save", undefined, error);
    return { error: "The change could not be saved. Try again." };
  }
}

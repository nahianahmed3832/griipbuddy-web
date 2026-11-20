import { addToItems, cartItemKey, MAX_QUANTITY, updateItems } from "./model.ts";
import type { CartChange, CartSyncSnapshot } from "./sync-contract.ts";

export type CartLines = Pick<CartSyncSnapshot, "items" | "saved">;
export type LineChange = Exclude<CartChange, { type: "complete-purchase" }>;
export const staleMessage = "This item changed on another device. Review the updated cart and try again.";
export const capacityMessage = "The cart or saved list is full. Remove an item or reduce a quantity and try again.";

export function applyLineChange(current: CartLines, command: LineChange, stock: number): CartLines | string {
  const { variantId, personalization, offerId } = command;
  if (command.type === "add") {
    const items = addToItems(current.items, variantId, command.quantity, stock, personalization, offerId);
    return items ? { ...current, items } : capacityMessage;
  }

  const key = cartItemKey(command);
  const source = command.type === "remove-saved" || command.type === "restore-saved" ? "saved" : "items";
  const line = current[source].find(item => cartItemKey(item) === key);
  if (command.expectedQuantity !== undefined && line?.quantity !== command.expectedQuantity) return staleMessage;
  if (!line) return command.type === "remove" || command.type === "remove-saved" ? current : staleMessage;

  switch (command.type) {
    case "set": {
      if (line.quantity === command.quantity) return current;
      const items = updateItems(current.items, variantId, command.quantity, stock, personalization, offerId);
      return items === current.items ? capacityMessage : { ...current, items };
    }
    case "move-to-saved": {
      const saved = addToItems(current.saved.filter(item => cartItemKey(item) !== key), variantId, line.quantity, MAX_QUANTITY, personalization, offerId);
      return saved ? { items: current.items.filter(item => cartItemKey(item) !== key), saved } : capacityMessage;
    }
    case "restore-saved": {
      const items = addToItems(current.items, variantId, line.quantity, stock, personalization, offerId);
      return items ? { items, saved: current.saved.filter(item => cartItemKey(item) !== key) } : capacityMessage;
    }
    case "remove":
      return { ...current, items: current.items.filter(item => cartItemKey(item) !== key) };
    case "remove-saved":
      return { ...current, saved: current.saved.filter(item => cartItemKey(item) !== key) };
  }
}


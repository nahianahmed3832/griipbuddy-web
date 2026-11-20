"use strict";

async function transferCart() {
  const status = document.getElementById("status");
  try {
    const requested = location.hash.slice(1).split(",").map(line => {
      const match = /^([a-f0-9]{24}):([a-f0-9]{24}):([1-5])$/.exec(line);
      if (!match) throw new Error("Invalid cart");
      return { productId: match[1], variantId: match[2], quantity: Number(match[3]) };
    });
    if (requested.length > 60 || new Set(requested.map(line => line.variantId)).size !== requested.length) {
      throw new Error("Invalid cart");
    }
    const api = "https://api.griipbuddy.com/api/v1";
    const options = { cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(12000) };

    const ids = [...new Set(requested.map(({ productId }) => productId))];
    const response = await fetch(api + "/product/ids?ids=" + ids.join(","), options);
    if (!response.ok) throw new Error("Could not check products");
    const { data } = await response.json();
    const byId = new Map(data.map(product => [product._id, product]));
    const items = [];
    for (const { productId, variantId, quantity } of requested) {
      const product = byId.get(productId);
      const variant = product?.variants.find(option => option._id === variantId);
      if (!product?.is_published || !product.sale_channels?.website || (product.region && product.region !== "BD") ||
          !variant || !Number.isFinite(variant.sale_price) || variant.sale_price <= 0) throw new Error("An item is unavailable");
      items.push({
        id: crypto.randomUUID(), addedAt: Date.now(), product, variantId, quantity,
        selectedColor: variant.attribute_values?.Color ?? variant.attribute_values?.color,
        selectedSize: variant.attribute_values?.Size ?? variant.attribute_values?.size,
        priceSnapshot: variant.sale_price,
      });
    }

    const key = "persist:root";
    const saved = localStorage.getItem(key);
    const persisted = saved ? JSON.parse(saved) : {};
    const previous = persisted.cart ? JSON.parse(persisted.cart) : { items: [] };
    const currentItems = Array.isArray(previous.items) ? previous.items : [];
    const merged = new Map(currentItems.map(line => [line.variantId, line]));
    for (const line of items) {
      // Replace the quantity for an incoming variant so a retry does not add it again.
      merged.set(line.variantId, line);
    }
    for (let offset = 0; offset < requested.length; offset += 6) {
      const available = await Promise.all(requested.slice(offset, offset + 6).map(async ({ productId, variantId }) => {
        const response = await fetch(api + "/stocks/" + productId + "/" + variantId, {
          ...options, signal: AbortSignal.timeout(12000),
        });
        const stock = response.ok ? (await response.json()).data?.totalAvailableQuantity : null;
        return Number.isInteger(stock) && stock >= merged.get(variantId).quantity;
      }));
      if (available.some(result => !result)) {
        status.textContent = "Stock has changed. Return to your cart and reduce the quantity or choose another variant.";
        return;
      }
    }
    persisted.cart = JSON.stringify({ ...previous, items: [...merged.values()], isOpen: false, isHydrated: true });
    localStorage.setItem(key, JSON.stringify(persisted));
    location.replace("/bd/checkout");
  } catch {
    status.textContent = "We couldn’t transfer your cart. Return to the new storefront and try again.";
  }
}

void transferCart();

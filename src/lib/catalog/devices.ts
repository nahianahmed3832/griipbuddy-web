import type { CatalogProduct } from "./types.ts";

// The catalog import preserves model tags from the original store. Match whole
// tags so, for example, iPhone 16 Pro cannot also select Pro Max cases.
const devices = [
  { name: "iPhone 16 Pro Max", tags: ["iphone 16 pro max"] },
  { name: "iPhone 16 Pro", tags: ["iphone 16 pro"] },
  { name: "iPhone 15 Pro Max", tags: ["iphone 15 pro max"] },
  { name: "iPhone 15 Pro", tags: ["iphone 15 pro"] },
  { name: "iPhone 14 Pro", tags: ["iphone 14 pro"] },
  { name: "Samsung Galaxy S25 Ultra", tags: ["s25 ultra", "galaxy s25 ultra"] },
  { name: "Samsung Galaxy S24 Ultra", tags: ["s24 ultra", "galaxy s24 ultra"] },
  { name: "iQOO Z11 Turbo", tags: ["z11 turbo", "iqoo z11 turbo"] },
  { name: "iQOO Z10 Turbo", tags: ["z10 turbo", "iqoo z10 turbo"] },
  { name: "iQOO Z9 Turbo", tags: ["z9 turbo", "iqoo z9 turbo"] },
  { name: "iQOO Neo 11", tags: ["neo 11", "iqoo neo 11"] },
  { name: "iQOO Neo 10", tags: ["neo 10", "iqoo neo 10"] },
  { name: "iQOO Neo 9", tags: ["neo 9", "iqoo neo 9"] },
  { name: "Redmi Turbo 4 Pro", tags: ["redmi turbo 4 pro", "turbo 4 pro"] },
  { name: "Redmi K80", tags: ["redmi k80"] },
  { name: "Honor 400 Pro", tags: ["honor 400 pro"] },
  { name: "Honor 400", tags: ["honor 400"] },
  { name: "Honor 200 Pro", tags: ["honor 200 pro"] },
  { name: "Honor 200", tags: ["honor 200"] },
  { name: "Nothing Phone (3a)", tags: ["nothing 3a", "nothing phone 3a"] },
  { name: "CMF Phone 2 Pro", tags: ["cmf 2 pro", "cmf phone 2 pro"] },
].map(device => ({ ...device, id: device.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "") }));

export function catalogDevices(products: readonly Pick<CatalogProduct, "keywords">[]) {
  const tags = new Set(products.flatMap(product => product.keywords.map(tag => tag.trim().toLowerCase())));
  return devices.filter(device => device.tags.some(tag => tags.has(tag)));
}

export function knownCatalogDevice(id: string) {
  return devices.some(device => device.id === id);
}

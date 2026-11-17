import { markets, retailMarketIds } from "../src/config/markets.ts";
import type { CatalogImage, Collection, Department, MarketOffer, Product, Variant } from "../src/lib/catalog/types.ts";

function photo(file: string, alt: string): CatalogImage {
  return { src: `/catalog/${file}.webp`, alt };
}

function editorial(file: string, alt: string): CatalogImage {
  return { src: `/editorial/${file}.webp`, alt };
}

const photos = {
  tote: photo("tote-plum", "Plum canvas carryall tote with stitched handles"),
  toteOat: photo("tote-oat", "Oat canvas carryall tote with stitched handles"),
  mug: photo("mug-cream", "Speckled cream ceramic mug with a rounded handle"),
  mugLilac: photo("mug-lilac", "Speckled lilac ceramic mug with a rounded handle"),
  headphones: photo("headphones-black", "Charcoal wireless headphones with padded ear cups"),
  headphonesTaupe: photo("headphones-taupe", "Taupe wireless headphones with padded ear cups"),
  tee: photo("tee-sage", "Folded sage cotton crew neck T-shirt"),
  teeCharcoal: photo("tee-charcoal", "Folded charcoal cotton crew neck T-shirt"),
  refill: photo("pump-bottle", "Butter yellow refillable pump bottle"),
  sneakers: photo("sneakers", "Pair of white low-top canvas sneakers"),
  beanie: photo("beanie", "Caramel rib-knit beanie with a folded cuff"),
  cushion: photo("cushion", "Rectangular clay pink linen cushion"),
  glass: photo("amber-glass", "Ribbed amber drinking glass"),
  lamp: photo("lamp", "Cream cordless lamp with a rounded dome shade"),
  speaker: photo("speaker", "Compact charcoal portable speaker"),
  cable: photo("cable", "White braided USB-C cable coiled on a warm gray surface"),
  stand: photo("phone-stand", "Sage aluminum phone stand"),
  stone: photo("gua-sha", "Terracotta-colored curved facial massage stone"),
  bands: photo("wash-bands", "Two mauve microfiber wrist wash bands"),
  brush: photo("hairbrush", "Bamboo paddle hairbrush on natural linen"),
  bottle: photo("water-bottle", "Plum insulated water bottle with a loop cap"),
  mat: photo("exercise-mat", "Rolled olive exercise mat with a carry strap"),
  rope: photo("jump-rope", "Coiled lavender jump rope with black handles"),
  pack: photo("waist-pack", "Mustard nylon waist pack with adjustable strap"),
  notebooks: photo("notebooks", "Olive and cream kraft notebooks stacked together"),
  bento: photo("lunch-box", "Cream lunch box with an ochre silicone band"),
  umbrella: photo("umbrella", "Compact folded olive umbrella with a wrist loop"),
  carrySet: editorial("carry", "Plum tote, notebook and water bottle arranged together"),
};

export const departments: readonly Department[] = [
  { id: "d-fashion", slug: "fashion", name: "Fashion", shortName: "Fashion", description: "Easy layers, everyday bags and accessories to put on repeat.", image: photos.tee },
  { id: "d-home", slug: "home-living", name: "Home & Living", shortName: "Home & Living", description: "Considered pieces for the rooms and rituals you live in.", image: photos.mug },
  { id: "d-electronics", slug: "electronics-accessories", name: "Electronics & Accessories", shortName: "Electronics", description: "Useful tech for listening, charging and keeping your setup tidy.", image: photos.headphones },
  { id: "d-beauty", slug: "beauty-personal-care", name: "Beauty & Personal Care", shortName: "Beauty & Care", description: "Practical tools for the routines you come back to.", image: photos.refill },
  { id: "d-sports", slug: "sports-outdoors", name: "Sports & Outdoors", shortName: "Sports & Outdoors", description: "Simple essentials for getting moving and heading outside.", image: photos.bottle },
  { id: "d-everyday", slug: "everyday-essentials", name: "Everyday Essentials", shortName: "Essentials", description: "Small, useful things to keep close on a busy day.", image: photos.notebooks },
];

type SeedOffer = readonly [amountMinor: number, stock: number] | null;
type SeedVariant = Variant & { bd: SeedOffer; us: SeedOffer };
type SeedProduct = Omit<Product, "specifications" | "variants"> & {
  specs: Record<string, string>;
  variants: readonly SeedVariant[];
};

function option(
  id: string,
  bd: SeedOffer,
  us: SeedOffer,
  options: Variant["options"] = {},
  image?: CatalogImage,
): SeedVariant {
  return { id: `v-${id}`, bd, us, options, image };
}

// Demo amounts are authored separately in BDT poisha and USD cents. A null offer is not sold in that market.
const seed: readonly SeedProduct[] = [
  {
    id: "p-tote", slug: "canvas-carryall-tote", name: "Canvas Carryall Tote", departmentId: "d-fashion",
    description: "A roomy cotton canvas tote for a book, a layer and the little things you pick up along the way. Wide straps sit comfortably on the shoulder, and an inside pocket keeps keys close.",
    specs: { Material: "Cotton canvas", Dimensions: "38 × 34 × 12 cm", Pockets: "One inside slip pocket", Care: "Spot clean and air dry" },
    keywords: ["bag", "work", "shopping", "shoulder", "travel"], images: [photos.tote, editorial("tote-detail", "Detail of the stitching on the plum canvas tote handle")],
    variants: [
      option("tote-plum", [125000, 12], [1800, 7], { Color: "Plum" }, photos.tote),
      option("tote-oat", [115000, 7], null, { Color: "Oat" }, photos.toteOat),
    ],
    addedOn: "2026-11-12", newArrival: true,
  },
  {
    id: "p-tee", slug: "weekend-cotton-tee", name: "Weekend Cotton Tee", departmentId: "d-fashion",
    description: "A soft, midweight crew neck with a relaxed fit for layering or wearing on its own.",
    specs: { Fabric: "Cotton jersey", Fit: "Relaxed", Neckline: "Crew neck", Care: "Machine wash cold" },
    keywords: ["shirt", "tshirt", "basics", "clothing", "unisex"], images: [photos.tee],
    variants: [
      option("tee-sage-s", [89000, 6], [1500, 4], { Color: "Sage", Size: "S" }, photos.tee),
      option("tee-sage-m", [89000, 8], [1500, 6], { Color: "Sage", Size: "M" }, photos.tee),
      option("tee-sage-l", [95000, 0], [1600, 3], { Color: "Sage", Size: "L" }, photos.tee),
      option("tee-charcoal-s", [89000, 5], [1500, 2], { Color: "Charcoal", Size: "S" }, photos.teeCharcoal),
      option("tee-charcoal-m", [89000, 6], [1500, 5], { Color: "Charcoal", Size: "M" }, photos.teeCharcoal),
      option("tee-charcoal-l", [95000, 4], [1600, 0], { Color: "Charcoal", Size: "L" }, photos.teeCharcoal),
    ],
    addedOn: "2026-11-09", newArrival: true,
  },
  {
    id: "p-sneakers", slug: "low-top-canvas-sneakers", name: "Low-Top Canvas Sneakers", departmentId: "d-fashion",
    description: "Simple lace-up canvas sneakers with a low profile and a flexible rubber sole.",
    specs: { Upper: "Canvas", Sole: "Rubber", Closure: "Lace-up", Sizing: "EU shoe sizes" },
    keywords: ["shoes", "trainers", "footwear", "white"], images: [photos.sneakers],
    variants: [
      option("sneakers-38", [225000, 4], [3200, 4], { Size: "EU 38" }),
      option("sneakers-39", [225000, 5], [3200, 7], { Size: "EU 39" }),
      option("sneakers-40", [225000, 5], [3200, 0], { Size: "EU 40" }),
    ],
    addedOn: "2026-11-05",
  },
  {
    id: "p-beanie", slug: "rib-knit-beanie", name: "Rib-Knit Beanie", departmentId: "d-fashion",
    description: "A soft rib-knit hat with a deep foldover cuff for cool mornings and evening walks.",
    specs: { Material: "Acrylic knit", Fit: "Stretch fit", Care: "Hand wash cold" },
    keywords: ["hat", "winter", "knit", "caramel"], images: [photos.beanie],
    variants: [option("beanie-caramel", [69000, 7], [1200, 8], { Color: "Caramel" })], addedOn: "2026-11-02",
  },
  {
    id: "p-mug", slug: "morning-stoneware-mug", name: "Morning Stoneware Mug", departmentId: "d-home",
    description: "A rounded, speckled mug with a generous handle and a softly glazed finish. Made for a slow first cup of coffee or tea.",
    specs: { Material: "Glazed stoneware", Capacity: "330 ml", Finish: "Speckled glaze", Care: "Wash by hand" },
    keywords: ["coffee", "tea", "cup", "kitchen", "ceramic"], images: [photos.mug, editorial("home", "Stoneware mug and amber glass on a sunny side table")],
    variants: [
      option("mug-cream", [68000, 9], [1400, 9], { Color: "Cream" }, photos.mug),
      option("mug-lilac", [75000, 0], [1550, 4], { Color: "Lilac" }, photos.mugLilac),
    ],
    addedOn: "2026-11-12", newArrival: true,
  },
  {
    id: "p-cushion", slug: "washed-linen-cushion", name: "Washed Linen Cushion", departmentId: "d-home",
    description: "A soft clay-colored cushion for a favorite chair or the corner of a sofa, with a removable textured cover.",
    specs: { Cover: "Linen blend", Size: "45 × 30 cm", Closure: "Hidden zip", Includes: "Cover and insert" },
    keywords: ["pillow", "sofa", "decor", "textiles"], images: [photos.cushion],
    variants: [option("cushion-clay", [145000, 7], [2400, 7], { Color: "Clay" })], addedOn: "2026-11-04",
  },
  {
    id: "p-glass", slug: "amber-ripple-glass", name: "Amber Ripple Glass", departmentId: "d-home",
    description: "An amber tumbler with a textured ribbed surface for water, iced coffee or whatever you are pouring.",
    specs: { Material: "Tinted glass", Capacity: "300 ml", Includes: "One glass", Care: "Wash by hand" },
    keywords: ["drinking", "glassware", "kitchen", "tumbler"], images: [photos.glass],
    variants: [option("glass-amber", [48000, 12], [950, 10], { Color: "Amber" })], addedOn: "2026-11-03", featured: true,
  },
  {
    id: "p-lamp", slug: "dome-table-lamp", name: "Dome Table Lamp", departmentId: "d-home",
    description: "A small cordless lamp with a smooth dome shade for a warm pool of light on a shelf or bedside table.",
    specs: { Finish: "Cream coated metal", Height: "23 cm", Power: "Rechargeable USB-C", Switch: "Touch control" },
    keywords: ["lighting", "bedside", "desk", "light"], images: [photos.lamp],
    variants: [option("lamp-cream", [298000, 4], null, { Color: "Cream" })], addedOn: "2026-11-01",
  },
  {
    id: "p-headphones", slug: "studio-wireless-headphones", name: "Studio Wireless Headphones", departmentId: "d-electronics",
    description: "Over-ear wireless headphones with padded cups, simple on-ear controls and a folding design for your bag.",
    specs: { Connection: "Bluetooth and 3.5 mm", Charging: "USB-C", Fit: "Adjustable over-ear band", Controls: "On-ear buttons" },
    keywords: ["audio", "music", "travel", "earphones", "bluetooth"], images: [photos.headphones, editorial("tech", "Wireless headphones beside a compact speaker and phone stand")],
    variants: [
      option("headphones-charcoal", [325000, 8], [4200, 5], { Color: "Charcoal" }, photos.headphones),
      option("headphones-taupe", [345000, 4], [4600, 0], { Color: "Taupe" }, photos.headphonesTaupe),
    ],
    addedOn: "2026-11-11", newArrival: true,
  },
  {
    id: "p-speaker", slug: "pocket-bluetooth-speaker", name: "Pocket Bluetooth Speaker", departmentId: "d-electronics",
    description: "A compact wireless speaker with tactile controls, sized for a desk, kitchen shelf or weekend bag.",
    specs: { Connection: "Bluetooth", Charging: "USB-C", Dimensions: "11 × 6 × 4 cm", Controls: "Physical buttons" },
    keywords: ["audio", "portable", "wireless", "music"], images: [photos.speaker],
    variants: [option("speaker-charcoal", [195000, 7], [2800, 8], { Color: "Charcoal" })], addedOn: "2026-11-06",
  },
  {
    id: "p-cable", slug: "braided-usb-c-cable", name: "Braided USB-C Cable", departmentId: "d-electronics",
    description: "A soft braided cable for connecting compatible USB-C devices, with a reusable wrap for tidy storage.",
    specs: { Connectors: "USB-C to USB-C", Jacket: "Braided nylon", Length: "1 m or 2 m" },
    keywords: ["charger", "charging", "cord", "usb c", "desk"], images: [photos.cable],
    variants: [
      option("cable-1m", [45000, 16], [850, 14], { Length: "1 m" }),
      option("cable-2m", [65000, 8], [1200, 10], { Length: "2 m" }),
    ],
    addedOn: "2026-11-03",
  },
  {
    id: "p-stand", slug: "foldaway-phone-stand", name: "Foldaway Phone Stand", departmentId: "d-electronics",
    description: "A folding stand that props a phone up for calls or recipes and packs flat between uses.",
    specs: { Material: "Anodized aluminum", Base: "Silicone pads", Angle: "Adjustable" },
    keywords: ["desk", "mobile", "holder", "work", "accessory"], images: [photos.stand],
    variants: [option("stand-sage", [85000, 8], [1400, 10], { Color: "Sage" })], addedOn: "2026-11-05", featured: true,
  },
  {
    id: "p-refill", slug: "refillable-pump-bottle", name: "Refillable Pump Bottle", departmentId: "d-beauty",
    description: "A refillable pump bottle for keeping your usual liquid soap or lotion within reach on the sink.",
    specs: { Capacity: "250 ml", Material: "PET bottle with plastic pump", Includes: "Empty bottle and pump" },
    keywords: ["skincare", "soap", "lotion", "bathroom", "dispenser"], images: [photos.refill],
    variants: [option("refill-butter", [39000, 14], [750, 12], { Color: "Butter" })], addedOn: "2026-11-04",
  },
  {
    id: "p-stone", slug: "contour-gua-sha", name: "Contour Gua Sha", departmentId: "d-beauty",
    description: "A smooth, gently curved facial massage tool, shaped to feel comfortable in the hand.",
    specs: { Material: "Terracotta-toned stone", Size: "8 × 5 cm", Care: "Rinse and pat dry" },
    keywords: ["massage", "face", "skincare", "beauty tool"], images: [photos.stone],
    variants: [option("stone-terracotta", [62000, 8], [1150, 6], { Color: "Terracotta" })], addedOn: "2026-11-02",
  },
  {
    id: "p-bands", slug: "microfiber-wash-bands", name: "Microfiber Wash Bands", departmentId: "d-beauty",
    description: "Slip these soft bands on your wrists before washing your face to catch drips.",
    specs: { Fabric: "Microfiber", Includes: "Two wrist bands", Care: "Machine wash gently" },
    keywords: ["skincare", "face wash", "wristbands", "bathroom"], images: [photos.bands],
    variants: [option("bands-mauve", [32000, 12], [650, 12], { Color: "Mauve" })], addedOn: "2026-11-01",
  },
  {
    id: "p-brush", slug: "bamboo-paddle-hairbrush", name: "Bamboo Paddle Hairbrush", departmentId: "d-beauty",
    description: "A compact bamboo brush with rounded pins and a cushioned base for everyday brushing.",
    specs: { Handle: "Bamboo", Pins: "Rounded bamboo", Length: "19 cm", Care: "Wipe clean" },
    keywords: ["hair", "grooming", "brush", "personal care"], images: [photos.brush],
    variants: [option("brush-natural", [59000, 7], [1050, 9], { Color: "Natural" })], addedOn: "2026-11-07", featured: true,
  },
  {
    id: "p-bottle", slug: "insulated-loop-bottle", name: "Insulated Loop Bottle", departmentId: "d-sports",
    description: "A compact stainless steel bottle with a screw lid and a loop that is easy to grab on the way out.",
    specs: { Capacity: "500 ml", Body: "Double-wall stainless steel", Lid: "Screw cap with carry loop", Care: "Wash by hand" },
    keywords: ["water", "hydration", "gym", "travel", "thermos"], images: [photos.bottle],
    variants: [option("bottle-plum", [135000, 10], [2250, 0], { Color: "Plum" })], addedOn: "2026-11-07",
  },
  {
    id: "p-mat", slug: "everyday-movement-mat", name: "Everyday Movement Mat", departmentId: "d-sports",
    description: "A roll-up exercise mat with a textured surface and a simple carry strap for stretching or floor workouts.",
    specs: { Material: "TPE foam", Size: "173 × 61 cm", Thickness: "6 mm", Includes: "Carry strap" },
    keywords: ["yoga", "fitness", "pilates", "exercise"], images: [photos.mat],
    variants: [option("mat-olive", [168000, 7], [2700, 5], { Color: "Olive" })], addedOn: "2026-11-05",
  },
  {
    id: "p-rope", slug: "adjustable-jump-rope", name: "Adjustable Jump Rope", departmentId: "d-sports",
    description: "A lightweight jump rope with grippy handles and an adjustable length for home workouts.",
    specs: { Rope: "PVC-coated cord", Length: "Up to 2.8 m", Handles: "Textured grips" },
    keywords: ["skipping", "exercise", "cardio", "gym"], images: [photos.rope],
    variants: [option("rope-lavender", [49000, 6], [950, 7], { Color: "Lilac" })], addedOn: "2026-11-02",
  },
  {
    id: "p-pack", slug: "trail-waist-pack", name: "Trail Waist Pack", departmentId: "d-sports",
    description: "A low-profile nylon bag for keys, a phone and small items on a walk or a day out.",
    specs: { Material: "Woven nylon", Capacity: "1.2 L", Strap: "Adjustable webbing", Pockets: "Two zip pockets" },
    keywords: ["belt bag", "fanny pack", "hiking", "running", "travel"], images: [photos.pack],
    variants: [option("pack-mustard", [99000, 9], [1600, 5], { Color: "Mustard" })], addedOn: "2026-11-04",
  },
  {
    id: "p-notebooks", slug: "pocket-notebook-pair", name: "Pocket Notebook Pair", departmentId: "d-everyday",
    description: "Two small ruled notebooks for lists, sketches or ideas you want to keep close.",
    specs: { Size: "A6", Pages: "48 ruled pages each", Cover: "Kraft card", Includes: "Two notebooks" },
    keywords: ["stationery", "paper", "journal", "writing", "work"], images: [photos.notebooks],
    variants: [option("notebooks-pair", [38000, 13], [700, 11])], addedOn: "2026-11-06", featured: true,
  },
  {
    id: "p-bento", slug: "stack-and-go-lunch-box", name: "Stack & Go Lunch Box", departmentId: "d-everyday",
    description: "A small bento-style lunch box with a divider and a soft band to hold the lid in place.",
    specs: { Capacity: "750 ml", Material: "Polypropylene", Includes: "Removable divider and silicone band", Care: "Wash by hand" },
    keywords: ["food", "bento", "container", "lunch", "work"], images: [photos.bento],
    variants: [option("bento-cream", [78000, 9], [1350, 9], { Color: "Cream" })], addedOn: "2026-11-08",
  },
  {
    id: "p-umbrella", slug: "pocket-folding-umbrella", name: "Pocket Folding Umbrella", departmentId: "d-everyday",
    description: "A compact folding umbrella with a wrist loop and a sleeve for tucking away after a rainy walk.",
    specs: { Canopy: "Polyester", Folded: "23 cm", Opening: "Manual", Includes: "Storage sleeve" },
    keywords: ["rain", "travel", "commute", "weather"], images: [photos.umbrella],
    variants: [option("umbrella-olive", [89000, 6], [1450, 7], { Color: "Olive" })], addedOn: "2026-11-01",
  },
  {
    id: "p-carry-set", slug: "everyday-carry-set", name: "Everyday Carry Set", departmentId: "d-everyday",
    description: "Three things for heading out the door: a roomy canvas tote, a pocket notebook and a loop-top bottle.",
    specs: { Bag: "Plum cotton canvas tote", Notebook: "A6 ruled", Bottle: "500 ml with carry loop", Includes: "Three pieces" },
    keywords: ["bag", "gift", "travel", "commute", "bundle", "stationery"], images: [photos.carrySet],
    variants: [option("carry-set", [245000, 4], [3850, 1])], addedOn: "2026-11-02",
  },
];

export const products: readonly Product[] = seed.map(({ specs, variants, ...product }) => ({
  ...product,
  specifications: Object.entries(specs).map(([label, value]) => ({ label, value })),
  variants: variants.map(({ id, options, image }) => ({ id, options, image })),
}));

export const offers: readonly MarketOffer[] = seed.flatMap(({ variants }) => variants.flatMap((variant) =>
  retailMarketIds.flatMap((marketId) => {
    const price = variant[marketId];
    return price ? [{ variantId: variant.id, marketId, currency: markets[marketId].currency, amountMinor: price[0], stock: price[1] }] : [];
  }),
));

export const collections: readonly Collection[] = [
  {
    id: "c-home", slug: "home-essentials", name: "Home Essentials", description: "Small comforts for the spaces you spend time in.",
    image: editorial("home", "Stoneware and amber glass on a warm, sunlit side table"),
    productIds: ["p-mug", "p-glass", "p-cushion", "p-lamp", "p-refill"],
  },
  {
    id: "c-carry", slug: "everyday-carry", name: "Everyday Carry", description: "Useful companions for wherever the day takes you.",
    image: editorial("carry", "Plum carryall, pocket notebook and bottle in warm daylight"),
    productIds: ["p-tote", "p-bottle", "p-notebooks", "p-umbrella", "p-bento", "p-carry-set", "p-pack"],
  },
  {
    id: "c-tech", slug: "useful-tech", name: "Useful Tech", description: "Simple upgrades for your desk, bag and downtime.",
    image: editorial("tech", "Headphones, speaker and a phone stand on a lavender-gray desktop"),
    productIds: ["p-headphones", "p-speaker", "p-stand", "p-cable"],
  },
  {
    id: "c-new", slug: "new-arrivals", name: "New Arrivals", description: "The latest additions to the GriipBuddy catalog.", selection: "new",
  },
  {
    id: "c-featured", slug: "featured", name: "Featured Picks", description: "A few practical favorites from across the store.", selection: "featured",
  },
];

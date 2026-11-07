# Selfridges reference audit

Observed 7 November 2026. The in-app browser rendered and interacted with the UK and Japan English storefronts. Headless Chromium received Cloudflare HTTP 403 responses from both homepages, so the audit continued in the in-app browser. The mobile captures use a 390 × 844 viewport override.

## Pages and patterns

| Surface | Observed |
| --- | --- |
| [UK home](https://www.selfridges.com/GB/en/) and [Japan English home](https://www.selfridges.com/JP/en/) | Brand, search, destination, account, wishlist and bag occupy the top row. Departments sit above an offer strip. The page alternates campaign media, shortcuts, product carousels, pairs of editorial stories and a membership feature. Japan shows yen prices and market-specific delivery copy and assortment. |
| Department menus | Opened Christmas, New in, Women, Men, Bags, Shoes, Beauty, Kids, Home & tech, Food & hampers, Jewellery, Gifts, Reselfridges and Shopping services. Menus separate all-department links, subcategories, curated edits, brand destinations and promotions. Arrow Down expanded the menus and Escape dismissed them. |
| [Women’s clothing](https://www.selfridges.com/GB/en/cat/womens/clothing/), [accessories](https://www.selfridges.com/GB/en/cat/womens/accessories/), [bags](https://www.selfridges.com/GB/en/cat/bags/), [technology](https://www.selfridges.com/GB/en/cat/home-tech/technology/) and [home](https://www.selfridges.com/GB/en/cat/home-tech/home/) | Bags has an editorial landing page with browse categories and a New In carousel. The other sampled pages expose a listing with department context, sidebar facets, product images, maker, title and price, and wishlist buttons. Clothing includes size and color, while technology emphasizes category, brand, color, sale and price. Opened the clothing sort menu and the searchable brand facet. |
| [Clothing product](https://www.selfridges.com/GB/en/product/reformation-rosemary-floral-textured-mesh-and-velvet-longline-coat_R04709153/), [technology product](https://www.selfridges.com/GB/en/product/nintendo-switch-2-console_R04473571/) and [accessory product](https://www.selfridges.com/GB/en/product/le-specs-fevered-oval-frame-bio-based-sunglasses_R04716874/) | Looked at imagery, gallery entry, brand and price hierarchy, product options and purchase controls, delivery and returns, related products and recently viewed. Opened the coat’s full gallery and the console’s specifications and the sunglasses’ delivery disclosures. The console and sunglasses expose quantity controls. |
| Search | Focus expands search. Typing headphones produced suggested searches and a separate product carousel. Submitting led to the [headphones category listing](https://www.selfridges.com/GB/en/cat/home-tech/technology/headphones/) and repopulated recent searches. An unmatched string reached the empty results page and displayed a prompt to try a different term. |
| [Bag](https://www.selfridges.com/GB/en/app/checkout/bag/) | Added one pair of sunglasses, opened the populated bag, inspected the line image, option, quantity, removal and delivery controls, selected two on mobile and removed the temporary item. Secure checkout opened the sign-in or guest choice. Stopped at the checkout entry. |
| Customer and service | Opened [wishlist](https://www.selfridges.com/GB/en/wishlist/), [account entry](https://www.selfridges.com/GB/en/app/account/signin-register/), the Unlocked member link, [contact](https://www.selfridges.com/GB/en/info/contact-us/), [FAQs](https://www.selfridges.com/GB/en/info/faqs/), [delivery](https://www.selfridges.com/GB/en/info/dispatch-delivery/uk-delivery/), [returns](https://www.selfridges.com/GB/en/info/returns/) and [order tracking](https://www.selfridges.com/GB/en/info/tracking-your-order/). Footer groups online shopping, customer service, store services and company information. |
| Mobile | Opened the menu on a 390px viewport, inspected the listing filter entry, product images, buying controls, and bag with quantity, removal and a separate checkout summary. Mobile prioritizes the drawer, vertically stacked buying details and readily reachable shopping actions. |

The audit covered representative routes and interactions. It did not verify a signed-in account, loyalty accrual, purchase, payment, shipment or return. It did not traverse deep pagination, test every department’s secondary routes, or validate the reference on a physical device.

## GriipBuddy adaptation

- Use the four published GriipBuddy retail departments and their actual descendants. Fashion, carry and lifestyle entries remain available where the configured catalog supplies them. The hosted preview does not fabricate them.
- Alternate an editorial hero, department shortcuts, current products, paired category stories, and rewards. Use GriipBuddy’s catalog imagery, wordmark, warm neutrals and restrained orange. Reference screenshots are kept here for review only.
- Preserve scoped catalog search, variant-specific stock and pricing, compare, quick view, wishlists, CMS content in configured environments, Discover, Deals, Group Buy, Coupons, Rewards and existing checkout modes.
- Keep the preview safe for browsing with public catalog reads and simulated checkout. Live account and order features remain available in their configured integration environments.

## Reference captures

[UK home](selfridges-uk-home-desktop.jpg) · [Japan home](selfridges-jp.jpg) · [Mega-menu](selfridges-uk-mega-menu.jpg) · [Clothing listing](selfridges-clothing.jpg) · [Clothing filters](selfridges-clothing-filters.jpg) · [Technology listing](selfridges-technology.jpg) · [Product](selfridges-coat.jpg) · [Gallery](selfridges-coat-gallery.jpg) · [Predictive search](selfridges-search.jpg) · [Results](selfridges-search-results.jpg) · [Empty results](selfridges-empty-search.jpg) · [Bag](selfridges-bag.jpg)

[Mobile home](selfridges-mobile-home.jpg) · [Mobile menu](selfridges-mobile-menu.jpg) · [Mobile filters](selfridges-mobile-filters.jpg) · [Mobile product](selfridges-mobile-product.jpg) · [Mobile bag](selfridges-mobile-bag.jpg)

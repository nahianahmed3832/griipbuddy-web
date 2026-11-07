import { fixturesEnabled, hostedCatalogPreview, publicBuild } from '@/features/public-build';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@fontsource-variable/manrope';
import '@fontsource-variable/inter';
import { apiConfigured } from '@/features/catalog/api';
import { catalogNavigation } from '@/features/catalog/data';
import { currentAccount } from '@/features/account/session';
import { recoveredWishlistEnabled } from '@/features/account/recovered';
import { AccountShoppingProvider } from '@/features/account/shopping-scope';
import { StorefrontShell } from '@/features/shell/storefront-shell';
import { siteContent, contentRows, text } from '@/features/home/content';
import './globals.css';
import './catalog.css';
import './cart.css';
import './account.css';
import './checkout.css';
import './marketplace.css';

export const metadata: Metadata = {
  title: { default: 'GriipBuddy — Good finds. Great grip.', template: '%s · GriipBuddy' },
  description: 'Discover technology, fashion, bags and everyday finds. Browse the GriipBuddy marketplace by country and currency.',
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [navigation, account, content] = await Promise.all([catalogNavigation().catch(() => null), currentAccount().catch(() => null), siteContent()]);
  const preview = publicBuild();
  const announcement = hostedCatalogPreview() ? 'Development storefront · Checkout simulation only'
    : fixturesEnabled() ? 'DEVELOPMENT PREVIEW · Synthetic catalog and offers'
      : preview ? 'Sample storefront · Explore the catalog'
        : text(contentRows(content.top_bar_messages).sort((a,b) => Number(a.position) - Number(b.position))[0]?.message);
  const shop = navigation ? <StorefrontShell {...navigation} signedIn={Boolean(account)} accountsEnabled={!preview && (apiConfigured() || fixturesEnabled())}
    announcement={announcement} preview={hostedCatalogPreview()}>{children}</StorefrontShell> : children;
  return <html lang="en"><body>
    {account ? <AccountShoppingProvider key={account.profile.id}
      scope={{ mode: account.mode, saved: account.profile.saved, cart: account.fixture?.cart,
        wishlistWritable: account.mode === 'fixture' || recoveredWishlistEnabled() }}>{shop}</AccountShoppingProvider> : shop}
  </body></html>;
}

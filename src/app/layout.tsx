import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@fontsource-variable/manrope';
import '@fontsource-variable/inter';
import { catalogNavigation } from '@/features/catalog/data';
import { currentAccount } from '@/features/account/session';
import { AccountShoppingProvider } from '@/features/account/shopping-scope';
import { StorefrontShell } from '@/features/shell/storefront-shell';
import { siteContent, contentRows, text } from '@/features/home/content';
import './globals.css';
import './catalog.css';
import './cart.css';
import './account.css';
import './checkout.css';

export const metadata: Metadata = {
  title: { default: 'GriipBuddy — Good things to carry', template: '%s · GriipBuddy' },
  description: 'Explore GriipBuddy’s everyday edit of technology, fashion, clothing, bags and lifestyle accessories.',
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [navigation, account, content] = await Promise.all([catalogNavigation().catch(() => null), currentAccount().catch(() => null), siteContent()]);
  const announcement = text(contentRows(content.top_bar_messages).sort((a,b) => Number(a.position) - Number(b.position))[0]?.message);
  const shop = navigation ? <StorefrontShell {...navigation} signedIn={Boolean(account)} announcement={announcement}>{children}</StorefrontShell> : children;
  return <html lang="en"><body>
    {account ? <AccountShoppingProvider key={account.profile.id}
      scope={{ mode: account.mode, saved: account.profile.saved, cart: account.fixture?.cart }}>{shop}</AccountShoppingProvider> : shop}
  </body></html>;
}

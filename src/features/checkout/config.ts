import 'server-only';
import { checkoutPreferences, sandboxProvider, supportsCheckoutMarket } from './admin-preferences';
import { methodDetails, methodIds, type MethodOption } from './contracts';
import { checkoutEnabled, checkoutPaused } from './runtime';

export { checkoutEnabled, checkoutPaused };

export function methodsFor(market: string): MethodOption[] {
  if (!checkoutEnabled() || checkoutPaused() || !supportsCheckoutMarket(market)) return [];
  const availability = checkoutPreferences().markets[market];
  return methodIds.flatMap<MethodOption>(id => {
    if (id === 'manual') return availability.manual ? [{ id, ...methodDetails[id], advancePercent:availability.manual.advancePercent }] : [];
    if ((id === 'paypal' || id === 'stripe') && !sandboxProvider[id]()) return [];
    return availability[id] ? [{ id, ...methodDetails[id] }] : [];
  });
}

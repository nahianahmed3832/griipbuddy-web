import 'server-only';
import { apiConfigured } from '@/features/catalog/api';

export function hasSecret(value?: string) { return (value?.length ?? 0) >= 32; }

export function checkoutEnabled() {
  return process.env.GRIIPBUDDY_CHECKOUT === 'synthetic' && !apiConfigured() && Boolean(process.env.GRIIPBUDDY_CHECKOUT_DIR) && hasSecret(process.env.GRIIPBUDDY_CHECKOUT_OPERATOR_SECRET);
}

export function checkoutPaused() {
  return checkoutEnabled() && process.env.GRIIPBUDDY_CHECKOUT_PAUSED === '1';
}

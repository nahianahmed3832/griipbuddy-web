import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const integrated = process.env.GRIIPBUDDY_TEST_SOURCE === 'integrated';
const publicPreview = process.env.GRIIPBUDDY_TEST_SOURCE === 'public';
const api = process.env.GRIIPBUDDY_TEST_SOURCE === 'api';
const release = process.env.GRIIPBUDDY_TEST_SOURCE === 'release';
const port = publicPreview ? 4329 : integrated ? 4325 : api ? 4321 : release ? 4322 : 4320;
const baseURL = 'http://127.0.0.1:' + port;
const peer = 4323;
const paused = 4324;
const token = () => randomBytes(32).toString('hex');

if (release || api) {
  process.env.GRIIPBUDDY_E2E_DIR ??= mkdtempSync(join(tmpdir(), 'griipbuddy-release-'));
  process.env.GRIIPBUDDY_E2E_OPERATOR ??= token();
  process.env.GRIIPBUDDY_E2E_STRIPE ??= token();
  process.env.GRIIPBUDDY_E2E_PAYPAL ??= token();
  process.env.GRIIPBUDDY_E2E_PAUSED = 'http://127.0.0.1:' + paused;
  process.env.GRIIPBUDDY_E2E_PEER = 'http://127.0.0.1:' + peer;
}

const server = (number: number) => ({
  command: 'npm run start -- --port ' + number,
  env: {
    GRIIPBUDDY_CATALOG_API: api || integrated || publicPreview ? 'http://127.0.0.1:38100/api/v1' : '',
    GRIIPBUDDY_DEV_CATALOG: integrated || publicPreview ? '1' : '',
    GRIIPBUDDY_RECOVERED_WISHLIST: api || integrated ? '1' : '',
    GRIIPBUDDY_PUBLIC_DEV: publicPreview ? '1' : '',
    GRIIPBUDDY_COUNTRY_HEADER: 'x-griipbuddy-country',
    GRIIPBUDDY_INTERNATIONAL_COUNTRY: 'US',
    GRIIPBUDDY_SHIPPING_RATES: api ? '{"BD":{"currency":"BDT","feeMinor":8000}}' : '{"BD":{"currency":"BDT","feeMinor":8000},"US":{"currency":"USD","feeMinor":700}}',
    GRIIPBUDDY_CHECKOUT_METHODS: '',
    GRIIPBUDDY_CHECKOUT_PAUSED: number === paused ? '1' : '',
    GRIIPBUDDY_CHECKOUT: integrated || publicPreview ? 'integrated' : release || api ? 'synthetic' : '',
    GRIIPBUDDY_CHECKOUT_DIR: process.env.GRIIPBUDDY_E2E_DIR ?? '',
    GRIIPBUDDY_CHECKOUT_OPERATOR_SECRET: process.env.GRIIPBUDDY_E2E_OPERATOR ?? '',
    GRIIPBUDDY_STRIPE_SIM_SECRET: process.env.GRIIPBUDDY_E2E_STRIPE ?? '',
    GRIIPBUDDY_PAYPAL_SIM_SECRET: process.env.GRIIPBUDDY_E2E_PAYPAL ?? '',
    GRIIPBUDDY_CANONICAL_ORIGIN: baseURL,
  },
  url: 'http://127.0.0.1:' + number,
  reuseExistingServer: false,
  timeout: 30000,
});

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results/' + (publicPreview ? 'public' : integrated ? 'integrated' : api ? 'api' : release ? 'release' : 'fixture'),
  testMatch: publicPreview ? ['public-preview.spec.ts'] : integrated ? ['integrated-flow.spec.ts'] : release ? ['release-checkout.spec.ts', 'release-quality.spec.ts'] : api
    ? ['catalog-api.spec.ts', 'cart-api.spec.ts', 'account-api.spec.ts'] : ['storefront.spec.ts', 'catalog.spec.ts', 'cart.spec.ts', 'account.spec.ts', 'route-audit.spec.ts'],
  reporter: 'list',
  use: { baseURL, browserName: 'chromium', trace: 'retain-on-failure' },
  webServer: release ? [server(port), server(peer), server(paused)] : server(port),
});

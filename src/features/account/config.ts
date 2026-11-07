import 'server-only';
import { apiConfigured } from '@/features/catalog/api';
import { fixturesEnabled, hostedCatalogPreview, publicBuild } from '@/features/public-build';

export function accountMode() {
  if (hostedCatalogPreview()) return 'fixture';
  if (publicBuild()) return undefined;
  return apiConfigured() ? 'recovered' : fixturesEnabled() ? 'fixture' : undefined;
}

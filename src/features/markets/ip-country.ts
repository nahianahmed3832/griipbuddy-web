import 'server-only';

import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { Reader, type CountryResponse } from 'mmdb-lib';

const decompress = promisify(gunzip);
let countryDatabase: Promise<Reader<CountryResponse>> | undefined;

export async function countryForIp(ip: string | null) {
  if (!ip || !isIP(ip)) return undefined;

  try {
    countryDatabase ??= readFile(join(process.cwd(), 'data', 'dbip-country-lite-2026-11.mmdb.gz'))
      .then((data) => decompress(data))
      .then((data) => new Reader<CountryResponse>(data));
    return (await countryDatabase).get(ip)?.country?.iso_code;
  } catch {
    return undefined;
  }
}

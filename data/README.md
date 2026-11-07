# Country lookup data

The development storefront uses the November 2026 DB-IP IP to Country Lite database. The database is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). [DB-IP download and attribution](https://db-ip.com/db/lite.php).

The compressed source is [dbip-country-lite-2026-11.mmdb.gz](https://download.db-ip.com/free/dbip-country-lite-2026-11.mmdb.gz). Its SHA-256 is `75fe430010f6d38a8c4331c202bf0df6ce3221a6e6d823b9e5a6d951e4cf9758`. To refresh it, replace the dated file with the current official country download and update the filename in the country lookup module.

The hosted development storefront reads the single client IP supplied by its loopback-only Nginx proxy. The proxy overwrites `X-Forwarded-For` with the client address. The app performs the lookup locally and uses only the country result for market selection.

import { productionMode } from "../release-config.ts";

export function merchandisingEnabled() {
  return !productionMode() && process.env.GRIIP_MERCHANDISING_ENABLED === "1";
}

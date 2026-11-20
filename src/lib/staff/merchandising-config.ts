import { productionMode } from "../release-config.ts";

export function merchandisingEnabled() {
  return !productionMode() && process.env.GRIIP_MERCHANDISING_ENABLED === "1";
}

export function merchandisingRunnerConnection() {
  const origin = process.env.GRIIP_MERCHANDISING_RUNNER;
  const token = process.env.GRIIP_MERCHANDISING_TOKEN;
  // This private connector is deployed on the same host or isolated network.
  return origin && token && /^http:\/\/(?:127\.0\.0\.1:[0-9]{4,5}|operations-api:38100)$/.test(origin) &&
    /^[a-f0-9]{64}$/.test(token) ? { origin, token } : null;
}

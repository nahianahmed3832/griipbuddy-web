import "./load-env.ts";
import { getDb } from "../src/lib/db/client.ts";
import { developmentAcceptanceDatabase } from "../src/lib/db/local.ts";
import { measurementEnabled, pruneMeasurement } from "../src/lib/measurement/server.ts";

if (!developmentAcceptanceDatabase() || !measurementEnabled() || process.env.GRIIP_MEASUREMENT_RETENTION_EXTERNAL !== "1") {
  throw new Error("Development measurement retention requires the isolated marketplace profile and external scheduling.");
}

try {
  const removed = await pruneMeasurement(new Date(), { testOnly: true });
  console.log(JSON.stringify({ job: "development-measurement-retention", removed }));
} finally {
  await getDb().$disconnect();
}

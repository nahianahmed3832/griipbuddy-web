export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.ACQUISITION_MEASUREMENT !== "1") return;
    if (process.env.GRIIP_MEASUREMENT_RETENTION_EXTERNAL === "1") {
      const { developmentAcceptanceDatabase } = await import("./lib/db/local");
      if (developmentAcceptanceDatabase()) return;
    }
    const { pruneMeasurement } = await import("./lib/measurement/server");
    const { reportFailure } = await import("./lib/db/observability");
    async function run() {
      try { await pruneMeasurement(); } catch (error) { reportFailure("measurement.retention", undefined, error); }
    }
    void run();
    // Expire first-party measurement on the self-hosted Next server.
    setInterval(run, 15 * 60_000).unref();
  }
}

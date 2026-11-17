export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.ACQUISITION_MEASUREMENT !== "1") return;
    const { pruneMeasurement } = await import("./lib/measurement/server");
    const { reportFailure } = await import("./lib/db/observability");
    async function run() {
      try { await pruneMeasurement(); } catch (error) { reportFailure("measurement.retention", undefined, error); }
    }
    void run();
    // Self-hosted Next server. Nothing is sent to advertising or analytics services.
    setInterval(run, 15 * 60_000).unref();
  }
}

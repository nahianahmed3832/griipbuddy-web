import "./load-env.ts";
import { getDb } from "../src/lib/db/client.ts";
import { notificationSandbox, runNotificationTestJob } from "../src/lib/notifications/test-delivery.ts";

if (notificationSandbox()) {
  try {
    const outcomes = new Map<string, number>();
    for (let index = 0; index < 12; index++) {
      const job = await runNotificationTestJob();
      if (!job) break;
      outcomes.set(job.state, (outcomes.get(job.state) ?? 0) + 1);
    }
    console.log(JSON.stringify({ notificationTestSink: Object.fromEntries(outcomes) }));
  } finally {
    await getDb().$disconnect();
  }
}

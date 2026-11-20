import "./load-env.ts";
import { expireInventoryReservations } from "../src/lib/commerce/inventory-reservations.ts";
import { getDb } from "../src/lib/db/client.ts";
import { developmentAcceptanceDatabase, localDatabase } from "../src/lib/db/local.ts";

const args = process.argv.slice(2);
const development = args.length === 0 && developmentAcceptanceDatabase();
const localTest = args.length === 1 && args[0] === "--local-test" && localDatabase() === "griipbuddy_test";
if (!development && !localTest) {
  throw new Error("Reservation expiry requires the isolated Marketplace development or loopback test profile.");
}

const db = getDb();
try {
  const [target] = await db.$queryRaw<{ name: string; role: string }[]>`SELECT current_database() AS name, current_user AS role`;
  if (development ? target?.name !== "griipbuddy_marketplace_dev" || target.role !== "griipbuddy_marketplace"
    : target?.name !== "griipbuddy_test") {
    throw new Error("The connected database does not match the reservation expiry profile.");
  }
  const expired = await expireInventoryReservations();
  console.log(JSON.stringify({ job: "development-inventory-reservation-expiry", expired }));
} finally {
  await db.$disconnect();
}

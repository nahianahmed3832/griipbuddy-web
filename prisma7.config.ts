import { config } from "dotenv";
import { defineConfig } from "prisma/config";

config({ path: process.env.GRIIPBUDDY_ENV_FILE ?? ".env", quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx scripts/seed.ts" },
  datasource: { url: process.env.DATABASE_URL ?? "" },
});

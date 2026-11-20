import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "../../generated/prisma/client.ts";
import { productionDatabase, stagingDatabase } from "./local.ts";

const cache = globalThis as typeof globalThis & { griipbuddyDb?: PrismaClient };

export function getDb(): PrismaClient {
  if (cache.griipbuddyDb) return cache.griipbuddyDb;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Set DATABASE_URL before running the storefront.");
  if (process.env.COMMERCE_MODE === "staging" && !stagingDatabase()) {
    throw new Error("Staging must use its dedicated private database service.");
  }
  if (process.env.COMMERCE_MODE === "production" && !productionDatabase()) {
    throw new Error("Production must use its dedicated private database and configured HTTPS origin.");
  }
  const adapter = new PrismaPg({ connectionString, max: 10, connectionTimeoutMillis: 5_000 });
  cache.griipbuddyDb = new PrismaClient({ adapter });
  return cache.griipbuddyDb;
}

export type DbReader = PrismaClient | Prisma.TransactionClient;

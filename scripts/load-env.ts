import { config } from "dotenv";

config({ path: process.env.GRIIPBUDDY_ENV_FILE ?? ".env", quiet: true });

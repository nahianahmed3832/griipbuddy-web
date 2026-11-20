import { cpSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { config } from "dotenv";

const envFile = process.env.GRIIPBUDDY_ENV_FILE ?? ".env";
const port = process.argv[2] ?? "3100";
const standalone = ".next/standalone";
if (!existsSync(`${standalone}/server.js`)) throw new Error("Run npm run build first.");
config({ path: envFile, quiet: true });
cpSync("public", `${standalone}/public`, { recursive: true });
cpSync(".next/static", `${standalone}/.next/static`, { recursive: true });
const child = spawn(process.execPath, ["server.js"], {
  cwd: standalone, stdio: "inherit", env: { ...process.env, PORT: port, HOSTNAME: "127.0.0.1" },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 0 : 1); });

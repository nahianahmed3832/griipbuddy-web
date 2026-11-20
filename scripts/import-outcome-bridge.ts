import "./load-env.ts";
import { getDb } from "../src/lib/db/client.ts";
import { bridgeMaxSignedBytes, configuredBridge, OutcomeBridgeError } from "../src/lib/measurement/bridge-contract.ts";
import { importOutcomeBridge, verifyOutcomeBridge } from "../src/lib/measurement/bridge-outcomes.ts";

async function readEnvelope() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.length;
    if (bytes > bridgeMaxSignedBytes) throw new OutcomeBridgeError("Signed evidence exceeded the bridge size limit.");
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

try {
  const [command = "import", ...args] = process.argv.slice(2);
  if (!["import", "verify"].includes(command) || args.length) throw new OutcomeBridgeError("Use import or verify and supply the signed export on stdin.");
  if (!configuredBridge()) throw new OutcomeBridgeError("The fixture outcome bridge is disabled or unconfigured.");
  const signed = await readEnvelope();
  try { console.log(JSON.stringify(await (command === "verify" ? verifyOutcomeBridge(signed) : importOutcomeBridge(signed)))); }
  finally { await getDb().$disconnect(); }
} catch (error) {
  console.error(error instanceof OutcomeBridgeError ? error.message : "Bridge import failed.");
  process.exitCode = 1;
}

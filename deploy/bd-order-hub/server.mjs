import express from "express";
import mongoose from "mongoose";
import routes from "../../src/app/modules/customer-orders/routes.js";

function stagingDatabase() {
  const url = new URL(process.env.DATABASE_URL);
  if (process.env.GRIIP_OPERATIONS_MODE !== "staging" || process.env.BD_ORDER_HUB_MODE !== "isolated" ||
      url.protocol !== "mongodb:" || url.hostname !== "bd-order-hub-mongo" || url.port !== "27017" ||
      url.pathname !== "/griipbuddy_order_hub_stage" || url.username !== "order_hub_reader" ||
      !url.password || url.search || url.hash || !/^[a-f0-9]{64}$/.test(process.env.BD_ORDER_HUB_BRIDGE_TOKEN ?? "")) {
    throw new Error("The order bridge requires the dedicated staging read-only database and bridge token.");
  }
  return url.href;
}

async function start() {
  await mongoose.connect(stagingDatabase(), { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5000 });
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({ "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" });
    next();
  });
  app.get("/health", (req, res) => res.sendStatus(mongoose.connection.readyState === 1 ? 204 : 503));
  app.use("/api/v1/customer-orders", express.json({ limit: "16kb" }), routes);
  app.use((req, res) => res.sendStatus(404));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status >= 400 && error.status < 500 ? error.status : 500;
    res.status(status).json({ message: status === 500 ? "Order service unavailable." : "Request was rejected." });
  });

  const server = app.listen(38100, "0.0.0.0");
  process.once("SIGTERM", () => server.close(() => void mongoose.disconnect()));
}

start().catch(error => {
  console.error("Order bridge startup failed:", error.name);
  process.exitCode = 1;
});

const database = db.getSiblingDB("griipbuddy_order_hub_stage");

database.createUser({
  user: "order_hub_reader",
  pwd: process.env.BD_ORDER_HUB_MONGO_READ_PASSWORD,
  roles: [{ role: "read", db: database.getName() }],
});

database.createUser({
  user: "order_hub_seed",
  pwd: process.env.BD_ORDER_HUB_MONGO_SEED_PASSWORD,
  roles: [{ role: "readWrite", db: database.getName() }],
});

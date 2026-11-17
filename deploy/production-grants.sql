-- Run as the database operator after applying migrations.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO griipbuddy_prod_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO griipbuddy_prod_app;
REVOKE ALL ON TABLE "_prisma_migrations" FROM griipbuddy_prod_app;
REVOKE DELETE ON TABLE "Order", "OrderItem", "Payment", "BangladeshManualProof", "FulfillmentEvent", "AuditEvent" FROM griipbuddy_prod_app;

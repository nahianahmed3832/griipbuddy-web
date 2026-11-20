ALTER TYPE "AuditAction" ADD VALUE 'SHOPPER_PASSWORD_CHANGED';

CREATE FUNCTION "recordShopperPasswordChange"() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- Shopper IDs are separate from the staff users referenced by AuditEvent.actorId.
    INSERT INTO "AuditEvent" ("id", "action", "target", "changes")
    VALUES (
        gen_random_uuid(),
        'SHOPPER_PASSWORD_CHANGED',
        'shopper:' || NEW."userId",
        '{"outcome":"SUCCESS"}'::jsonb
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER "shopperPasswordChangeAudit"
AFTER UPDATE OF "password" ON "ShopperIdentity"
FOR EACH ROW
WHEN (
    OLD."providerId" = 'credential' AND NEW."providerId" = 'credential'
    AND OLD."password" IS NOT NULL AND NEW."password" IS NOT NULL
    AND OLD."password" IS DISTINCT FROM NEW."password"
)
EXECUTE FUNCTION "recordShopperPasswordChange"();

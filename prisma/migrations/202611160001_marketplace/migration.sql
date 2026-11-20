-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "marketplaceShopId" UUID;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "gift" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "giftNote" TEXT,
ADD COLUMN     "shopperId" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "marketplaceShopId" UUID;

-- CreateTable
CREATE TABLE "Shopper" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shopper_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopperSession" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "ShopperSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopperIdentity" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopperIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopperVerification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopperVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceShop" (
    "id" UUID NOT NULL,
    "ownerId" TEXT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "announcement" TEXT NOT NULL,
    "about" TEXT NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketplaceShop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopperFavorite" (
    "shopperId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopperFavorite_pkey" PRIMARY KEY ("shopperId","productId")
);

-- CreateTable
CREATE TABLE "ShopperList" (
    "id" UUID NOT NULL,
    "shopperId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "registry" BOOLEAN NOT NULL DEFAULT false,
    "public" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopperList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopperListItem" (
    "listId" UUID NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopperListItem_pkey" PRIMARY KEY ("listId","productId")
);

-- CreateTable
CREATE TABLE "ShopperFollow" (
    "shopperId" TEXT NOT NULL,
    "shopId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopperFollow_pkey" PRIMARY KEY ("shopperId","shopId")
);

-- CreateTable
CREATE TABLE "ShopperReview" (
    "id" UUID NOT NULL,
    "shopperId" TEXT NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" TEXT NOT NULL,
    "stars" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "visible" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopperReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopperRequest" (
    "id" UUID NOT NULL,
    "shopperId" TEXT NOT NULL,
    "shopId" UUID NOT NULL,
    "orderId" UUID,
    "subject" TEXT NOT NULL,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopperRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopperMessage" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "fromShop" BOOLEAN NOT NULL DEFAULT false,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopperMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopperAddress" (
    "id" UUID NOT NULL,
    "shopperId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopperAddress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shopper_email_key" ON "Shopper"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ShopperSession_token_key" ON "ShopperSession"("token");

-- CreateIndex
CREATE INDEX "ShopperSession_userId_idx" ON "ShopperSession"("userId");

-- CreateIndex
CREATE INDEX "ShopperIdentity_userId_idx" ON "ShopperIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopperIdentity_providerId_accountId_key" ON "ShopperIdentity"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "ShopperVerification_identifier_idx" ON "ShopperVerification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceShop_ownerId_key" ON "MarketplaceShop"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceShop_slug_key" ON "MarketplaceShop"("slug");

-- CreateIndex
CREATE INDEX "ShopperFavorite_shopperId_createdAt_idx" ON "ShopperFavorite"("shopperId", "createdAt");

-- CreateIndex
CREATE INDEX "ShopperList_shopperId_createdAt_idx" ON "ShopperList"("shopperId", "createdAt");

-- CreateIndex
CREATE INDEX "ShopperListItem_listId_createdAt_idx" ON "ShopperListItem"("listId", "createdAt");

-- CreateIndex
CREATE INDEX "ShopperReview_productId_visible_createdAt_idx" ON "ShopperReview"("productId", "visible", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopperReview_orderId_productId_key" ON "ShopperReview"("orderId", "productId");

-- CreateIndex
CREATE INDEX "ShopperRequest_shopperId_updatedAt_idx" ON "ShopperRequest"("shopperId", "updatedAt");

-- CreateIndex
CREATE INDEX "ShopperRequest_shopId_updatedAt_idx" ON "ShopperRequest"("shopId", "updatedAt");

-- CreateIndex
CREATE INDEX "ShopperMessage_requestId_createdAt_idx" ON "ShopperMessage"("requestId", "createdAt");

-- CreateIndex
CREATE INDEX "ShopperAddress_shopperId_createdAt_idx" ON "ShopperAddress"("shopperId", "createdAt");

-- CreateIndex
CREATE INDEX "Product_marketplaceShopId_publication_idx" ON "Product"("marketplaceShopId", "publication");

-- CreateIndex
CREATE INDEX "Order_shopperId_createdAt_idx" ON "Order"("shopperId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderItem_marketplaceShopId_orderId_idx" ON "OrderItem"("marketplaceShopId", "orderId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_marketplaceShopId_fkey" FOREIGN KEY ("marketplaceShopId") REFERENCES "MarketplaceShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_shopperId_fkey" FOREIGN KEY ("shopperId") REFERENCES "Shopper"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopperSession" ADD CONSTRAINT "ShopperSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Shopper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopperIdentity" ADD CONSTRAINT "ShopperIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Shopper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketplaceShop" ADD CONSTRAINT "MarketplaceShop_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Shopper"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopperFavorite" ADD CONSTRAINT "ShopperFavorite_shopperId_fkey" FOREIGN KEY ("shopperId") REFERENCES "Shopper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopperFavorite" ADD CONSTRAINT "ShopperFavorite_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopperList" ADD CONSTRAINT "ShopperList_shopperId_fkey" FOREIGN KEY ("shopperId") REFERENCES "Shopper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopperListItem" ADD CONSTRAINT "ShopperListItem_listId_fkey" FOREIGN KEY ("listId") REFERENCES "ShopperList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopperListItem" ADD CONSTRAINT "ShopperListItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopperFollow" ADD CONSTRAINT "ShopperFollow_shopperId_fkey" FOREIGN KEY ("shopperId") REFERENCES "Shopper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopperFollow" ADD CONSTRAINT "ShopperFollow_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "MarketplaceShop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopperReview" ADD CONSTRAINT "ShopperReview_shopperId_fkey" FOREIGN KEY ("shopperId") REFERENCES "Shopper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopperReview" ADD CONSTRAINT "ShopperReview_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopperReview" ADD CONSTRAINT "ShopperReview_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopperRequest" ADD CONSTRAINT "ShopperRequest_shopperId_fkey" FOREIGN KEY ("shopperId") REFERENCES "Shopper"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopperRequest" ADD CONSTRAINT "ShopperRequest_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "MarketplaceShop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopperRequest" ADD CONSTRAINT "ShopperRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopperMessage" ADD CONSTRAINT "ShopperMessage_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ShopperRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopperAddress" ADD CONSTRAINT "ShopperAddress_shopperId_fkey" FOREIGN KEY ("shopperId") REFERENCES "Shopper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShopperReview" ADD CONSTRAINT "ShopperReview_stars_range" CHECK ("stars" BETWEEN 1 AND 5);

INSERT INTO "MarketplaceShop" ("id", "slug", "name", "announcement", "about", "published", "updatedAt")
VALUES ('00000000-0000-4000-8000-000000000001', 'griipbuddy', 'GriipBuddy', '', 'Phone cases, screen and camera protectors, and tech accessories.', true, CURRENT_TIMESTAMP);

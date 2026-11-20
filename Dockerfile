# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22.22.3-bookworm-slim
FROM ${NODE_IMAGE} AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS source
COPY package.json package-lock.json prisma7.config.ts ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY . .

FROM source AS operator
CMD ["npm", "run", "db:migrate"]

FROM source AS build
ARG NEXT_PUBLIC_STOREFRONT_BASE_PATH=
ARG HYBRID_STOREFRONT_BUILD=0
ENV STAGING_BUILD=1 NEXT_PUBLIC_STOREFRONT_BASE_PATH=${NEXT_PUBLIC_STOREFRONT_BASE_PATH} HYBRID_STOREFRONT_BUILD=${HYBRID_STOREFRONT_BUILD}
RUN npm run verify

FROM base AS runtime
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]

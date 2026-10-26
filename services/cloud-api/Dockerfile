# Matchframe website + cloud API (accounts, billing, device linking, licences, auto-director usage).
# Build from the repository root:
#   docker build -f services/cloud-api/Dockerfile -t matchframe-cloud .
# Configuration is environment-only; see docs/operations/cloud-deployment.md.

FROM node:22.22.0-bookworm-slim AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile --filter "@matchframe/cloud-api..." --filter "@matchframe/cloud-web..."
RUN pnpm --filter @matchframe/cloud-web build && pnpm --filter @matchframe/cloud-api bundle

FROM node:22.22.0-bookworm-slim
WORKDIR /app
# PGlite is only used when DATABASE_URL is not set (single-machine trials); production uses Postgres.
RUN npm install --omit=dev --no-audit --no-fund --no-save @electric-sql/pglite@0.5.8 && npm cache clean --force
COPY --from=build /src/services/cloud-api/dist/ /app/dist/
COPY --from=build /src/apps/cloud-web/dist/ /app/web/
RUN mkdir -p /data && chown node:node /data
# The port comes from PORT (set by platforms such as Railway) or MF_CLOUD_PORT, default 8080.
ENV NODE_ENV=production \
    MF_CLOUD_HOST=0.0.0.0 \
    MF_CLOUD_WEB_DIR=/app/web
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.MF_CLOUD_PORT||process.env.PORT||8080)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.mjs"]

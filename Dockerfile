# syntax=docker/dockerfile:1
#
# ─────────────────────────────────────────────────────────────────────────────
# Antigravity Gateway — multi-stage container image
#
# The image contains the gateway itself. The Google Antigravity CLI (`agy`) is
# NOT bundled: either mount your existing `agy` binary and its credentials into
# the container, or set GEMINI_API_KEY in .env (quota reporting via `/usage` is
# disabled in API-key mode). See docs/QUICKSTART.md § "Docker / 容器部署".
#
#   docker build -t antigravity-gateway .
#   docker compose up -d --build
# ─────────────────────────────────────────────────────────────────────────────

# ----- Build stage: install all dependencies and compile TypeScript -----
FROM node:24-slim AS build
WORKDIR /app

# Enable pnpm through Corepack (bundled with Node 24).
RUN corepack enable pnpm

# Reproducible install from the frozen lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Compile src/ -> dist/ with tsc.
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# ----- Runtime stage: production dependencies + compiled output -----
FROM node:24-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable pnpm

# Production dependencies only.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=build --chown=node:node /app/dist ./dist

# Writable directories for the rotating logger and persisted state. When
# ./data is bind-mounted from the host it must be writable by UID 1000 (see
# docker-compose.yml).
RUN mkdir -p /app/data /app/logs && chown -R node:node /app

# Health endpoint: enabled inside the container so HEALTHCHECK and the
# published loopback port both work. Binding 0.0.0.0 is container-internal;
# docker-compose.yml publishes it only on 127.0.0.1.
ENV HEALTH_ENABLED=true \
    HEALTH_HOST=0.0.0.0 \
    HEALTH_PORT=18790

# Drop privileges: the gateway and logger run as the unprivileged `node` user.
USER node

# Liveness probe on /healthz: returns 200 while at least one channel is live
# (status "ok", or "degraded" with a connected channel), so a single flapping
# channel in a multi-channel deployment cannot crash-loop the whole gateway.
# Total outage or startup returns 503. Use /readyz for strict readiness that
# requires every channel to be fully up before routing traffic.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:18790/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 18790: health/status. The callback receivers (18791-18796) stay on loopback
# unless you explicitly publish one behind a TLS tunnel; the 14 outbound-only
# channels need no inbound ports at all.
EXPOSE 18790

CMD ["node", "dist/index.js"]
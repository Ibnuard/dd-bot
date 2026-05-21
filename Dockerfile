# Multi-stage build for a minimal production image.
#
# Stage 1: install dependencies (cached unless package*.json changes)
# Stage 2: copy app code on top of a clean alpine + node_modules

FROM node:20-alpine AS deps
WORKDIR /app

# Copy only manifests first so this layer caches when source code changes
COPY package.json package-lock.json* ./

# --omit=dev keeps devDependencies (none here) out of the final image
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# ----------------------------------------------------------------------

FROM node:20-alpine AS runner
WORKDIR /app

# Run as the prebuilt non-root `node` user for safer filesystem access
ENV NODE_ENV=production
USER node

COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

EXPOSE 3000

# Quick liveness probe; the bot answers /health with 200 when polling is up
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:${PORT:-3000}/health || exit 1

CMD ["node", "index.js"]

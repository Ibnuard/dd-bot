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

# Run as the prebuilt non-root `node` user for safer filesystem access.
ENV NODE_ENV=production

# Pre-create the data dir with the right owner BEFORE switching user.
# When docker compose mounts a fresh named volume here, it seeds the volume
# from the image — including this ownership. Without this, the volume root
# stays owned by root and the non-root process gets EACCES on write.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

CMD ["node", "index.js"]

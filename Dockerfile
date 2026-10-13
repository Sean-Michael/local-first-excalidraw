# syntax=docker/dockerfile:1
# Build stage: the only stage with network access (npm ci from the lockfile, scripts disabled).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts
COPY tsconfig.server.json tsconfig.web.json vite.config.ts ./
COPY src ./src
COPY test ./test
RUN npm run build && npm test && npm prune --omit=dev --ignore-scripts

# Runtime: three small server deps + prebuilt static assets, non-root, no shell tools needed.
FROM node:22-alpine
ENV NODE_ENV=production \
    LFX_HOST=0.0.0.0 \
    LFX_PORT=7467 \
    LFX_STATE_DIR=/state \
    LFX_ROOTS=/workspace \
    LFX_PROJECT_ROOT=/workspace \
    LFX_LOCK_ROOTS=1 \
    LFX_NO_BROWSER=1
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY --from=build /app/dist/web ./dist/web
RUN ln -s /app/dist/src/server/cli.js /usr/local/bin/lfx \
 && mkdir -p /state /workspace && chown node:node /state /workspace
USER node
EXPOSE 7467
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:7467/api/health || exit 1
CMD ["node", "dist/src/server/cli.js", "serve"]

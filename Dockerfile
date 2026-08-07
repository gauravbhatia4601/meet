# syntax=docker/dockerfile:1

# --- Build stage ---
FROM node:22-alpine AS build
WORKDIR /app

# Install dependencies deterministically (workspaces). package-lock is committed.
# Force NODE_ENV=development for this stage: the build stage always needs dev
# deps (typescript, vite). If NODE_ENV=production leaks in from the host/build
# args, `npm ci` skips devDeps and `tsc`/`vite` are missing -> exit 127.
ENV NODE_ENV=development
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --include=dev

# Build the client (Vite). Defaults to same-origin signaling; override
# VITE_SERVER_URL here only if hosting the client and server separately.
COPY client/ client/
RUN npm run build -w client

# Build the server (tsc -> dist)
COPY server/ server/
RUN npm run build -w server

# --- Runtime stage ---
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

# Copy only production deps + built artifacts. Fresh install keeps layers lean.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist

EXPOSE 3001

# Non-root user for security
RUN addgroup -S app && adduser -S app -G app
USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

# Env is injected at runtime (docker-compose / docker run). See
# docker-compose.yml for the full list of supported variables.
CMD ["node", "server/dist/index.js"]

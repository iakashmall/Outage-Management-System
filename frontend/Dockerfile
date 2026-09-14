# frontend/Dockerfile
# Multi-stage build: Vite produces a static bundle (dist/), which needs no
# Node runtime at all in production -- just a static file server. nginx is
# the standard choice: tiny image, battle-tested, handles the SPA fallback
# routing (client-side routes) with one config line.

# ---------- Stage 1: build the static bundle ----------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# ---------- Stage 2: serve with nginx ----------
FROM nginx:1.27-alpine AS runtime

# SPA fallback: any path nginx can't find on disk (e.g. a client-side route
# like /incidents/INC-123) should still serve index.html so React Router
# can take over, instead of nginx returning a bare 404.
COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]

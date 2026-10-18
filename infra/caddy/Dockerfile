# Edge: Caddy with the layer4 module (TURN/TLS shares TCP 443 by SNI) + the Angular build as static files.
# Build context: repository root.  docker build -f infra/caddy/Dockerfile -t hangar-edge:<version> .
FROM node:22.22.0-alpine AS web
WORKDIR /web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm install -g npm@11.6.2 --cache /tmp/npm && npm ci --cache /tmp/npm --no-audit --no-fund
COPY apps/web/ ./
RUN npx ng build --configuration production

FROM caddy:2.11.4-builder-alpine AS caddy
RUN xcaddy build v2.11.4 --with github.com/mholt/caddy-l4@v0.1.2

FROM caddy:2.11.4-alpine
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY --from=web /web/dist/web/browser /srv/web
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile

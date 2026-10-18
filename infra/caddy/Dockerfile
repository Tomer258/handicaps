# Edge: Caddy with the layer4 module (TURN/TLS shares TCP 443 by SNI) + the Angular build as static files.
# Build context: repository root.  docker build -f infra/caddy/Dockerfile -t hangar-edge:<version> .
FROM node:22.22.0-alpine@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34 AS web
WORKDIR /web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm install -g npm@11.6.2 --cache /tmp/npm && npm ci --cache /tmp/npm --no-audit --no-fund
COPY apps/web/ ./
RUN npx ng build --configuration production

FROM caddy:2.11.4-builder-alpine@sha256:0aa610043dab5da82ad0a0268e46bb852785e6f5160f12f1c6fe3f42903d7e1b AS caddy
RUN xcaddy build v2.11.4 --with github.com/mholt/caddy-l4@v0.1.2

FROM caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY --from=web /web/dist/web/browser /srv/web
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile

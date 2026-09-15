# Playground, self-hosted.
#
# This is the better environment for the product, not a downgrade from the
# serverless deployment. A box with a disk gets SQLite instead of metered blob
# storage, WebSockets instead of HTTP polling — so presence and live cursors
# work — and a real browser the server can drive, so agents can take their own
# screenshots. None of those are possible on a serverless host.
#
# The server runs its TypeScript directly through Node's type stripping, so
# there is no server build step: the runtime image carries the sources. Only the
# web client is compiled, in the builder stage.

# --- Build the web client --------------------------------------------------

FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Manifests first, so a dependency install is only redone when they change.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci

COPY . .
RUN npm run build:web

# --- Runtime ---------------------------------------------------------------

FROM node:22-bookworm-slim AS runner

# Screenshots need a browser the server can drive. It is worth roughly 400MB,
# so it is a choice rather than an assumption: build with
# `--build-arg WITH_BROWSER=false` for a lean image, and `get_screenshot` will
# then tell agents plainly that it is unavailable instead of failing obscurely.
ARG WITH_BROWSER=true

ENV NODE_ENV=production \
    PORT=4000 \
    PLAYGROUND_DB=/data/playground.db \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev

# Playwright is a devDependency, so the production install above skips it. It is
# added back deliberately, pinned to the same major the project develops against.
RUN if [ "$WITH_BROWSER" = "true" ]; then \
      npm install --no-save playwright@1.63.0 && \
      npx playwright install --with-deps chromium && \
      rm -rf /var/lib/apt/lists/*; \
    fi

COPY packages/shared/src packages/shared/src
COPY packages/server/src packages/server/src
COPY --from=builder /app/packages/web/dist packages/web/dist

# Everything durable lives here: the document database and, in the same file,
# every uploaded asset. One volume is the whole backup.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 4000

# `curl` is not in the slim image, and adding it for one check is not worth a
# layer when the runtime can make the request itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]

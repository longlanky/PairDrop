FROM alpine:3.22

WORKDIR /home/node/app

COPY package*.json ./

RUN apk add --no-cache nodejs npm
RUN NODE_ENV="production" npm ci --omit=dev

# Directories and files excluded via .dockerignore
COPY . .

# run the application as an unprivileged user
RUN addgroup -S node && adduser -S -G node node && chown -R node:node /home/node/app

# environment settings
ENV NODE_ENV="production"

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/healthz || exit 1

USER node

# Run node directly (not via npm) so signals reach the process and it can shut down gracefully.
# Add runtime flags here, e.g. ["node", "server/index.js", "--rate-limit", "--auto-restart"].
CMD ["node", "server/index.js"]
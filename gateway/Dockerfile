# -----------------------------------------------------------------------------
# Gateway sub-container image (OCPP relay).
#
# Same sandbox posture as the main integration image: read-only rootfs,
# non-root user, dumb-init for correct SIGTERM handling. No /data volume: all
# state is kept in memory and reset on restart (documented limitation, see
# docs/en.md / docs/fr.md).
# -----------------------------------------------------------------------------

FROM node:24-alpine

RUN apk add --no-cache dumb-init

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV GATEWAY_PORT=9321
ENV UI_PORT=9080
EXPOSE 9321 9080

USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/gateway.ts"]

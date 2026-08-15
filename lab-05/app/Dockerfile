# syntax=docker/dockerfile:1

FROM node:22.22-alpine3.22 AS deps

WORKDIR /build

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force


FROM node:22.22-alpine3.22 AS runtime

RUN apk add --no-cache dumb-init=1.2.5-r3

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

COPY --from=deps --chown=node:node /build/node_modules ./node_modules
COPY --chown=node:node package.json server.js app.js version.js ./
COPY --chown=node:node store ./store
COPY --chown=node:node public ./public

ARG VERSION_LABEL=local-dev
ARG COMMIT=unknown
ARG BUILT_AT=

RUN printf '{"versionLabel":"%s","commit":"%s","builtAt":"%s"}\n' \
      "$VERSION_LABEL" "$COMMIT" "$BUILT_AT" > build-info.json \
    && chown node:node build-info.json

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "server.js"]

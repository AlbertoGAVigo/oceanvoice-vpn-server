FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
RUN apt-get update && apt-get install -y --no-install-recommends easy-rsa openssl \
    && rm -rf /var/lib/apt/lists/*
COPY server.mjs pki.mjs connections.mjs settings.mjs access.mjs remote.mjs index.html panel.css panel.js remote.html remote.js remote.css ./
EXPOSE 8080
CMD ["node", "server.mjs"]

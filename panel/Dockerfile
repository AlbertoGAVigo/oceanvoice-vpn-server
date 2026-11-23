FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends easy-rsa openssl \
    && rm -rf /var/lib/apt/lists/*
COPY server.mjs pki.mjs connections.mjs index.html panel.css panel.js ./
EXPOSE 8080
CMD ["node", "server.mjs"]

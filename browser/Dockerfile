FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium chromium-sandbox xvfb x11vnc xauth nftables iproute2 fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 20000 remote-browser \
    && for n in 0 1 2 3 4 5 6 7; do useradd -u $((20000+n)) -g 20000 -M -s /usr/sbin/nologin browser$n; done
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.mjs ./
ENV NODE_ENV=production
EXPOSE 8091
CMD ["node", "server.mjs"]

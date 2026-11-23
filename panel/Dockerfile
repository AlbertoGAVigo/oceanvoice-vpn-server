FROM node:22-bookworm-slim
WORKDIR /app
COPY server.mjs index.html panel.css ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]

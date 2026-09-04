# Rare-roll Discord bot — tiny always-on worker.
FROM node:20-alpine

WORKDIR /app

# Install production deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# Health/status endpoint; hosts route their health checks here.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "bot.mjs"]

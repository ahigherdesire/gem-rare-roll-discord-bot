# Rare-roll Discord bot — tiny always-on worker.
# Node 22+ is required: @supabase/supabase-js relies on a native global
# WebSocket, which only exists from Node 22 onward.
FROM node:22-alpine

WORKDIR /app

# Install production deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# Health/status endpoint; hosts route their health checks here.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "bot.mjs"]

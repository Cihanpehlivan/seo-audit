FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# Run as the non-root "node" user. Only crawls/ is writable.
RUN mkdir -p /app/crawls && chown node:node /app/crawls
USER node
ENV HOST=0.0.0.0 PORT=3300
EXPOSE 3300
CMD ["node", "src/server.js"]

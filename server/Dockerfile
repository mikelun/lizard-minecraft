FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY server/ ./server/
RUN npx tsc -p server/tsconfig.json

FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/server/dist/ ./server/dist/
COPY server/package.json ./server/package.json
EXPOSE 9001
CMD ["node", "server/dist/index.js"]

# Café POS — production image (Next.js server). Database: PostgreSQL via DATABASE_URL.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx next build

FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache tzdata
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 TZ=Africa/Tunis PORT=3000
COPY --from=build --chown=node:node /app ./
USER node
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]

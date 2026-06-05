# Stage 1: Build TypeScript
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json tsconfig.json drizzle.config.ts ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci
COPY src ./src
RUN npm run build

# Stage 2: Production runtime
FROM node:20-slim AS runner

# Install system Chromium + required fonts + sqlite3 CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production deps only; skip Playwright browser download
COPY package*.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev

# Copy compiled output and static assets
COPY --from=builder /app/dist ./dist
COPY drizzle ./drizzle
COPY public ./public
RUN mkdir -p /app/data

# Point Playwright to system Chromium (already supported in src/scraper/browser.ts)
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 3000
CMD ["node", "dist/index.js"]

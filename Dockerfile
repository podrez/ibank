# Use official Playwright image with Chromium pre-installed
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# Install dependencies first (layer caching)
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
RUN npm run build

# Copy migration files
COPY drizzle ./drizzle

# Web UI static assets
COPY public ./public

# Data directory for SQLite and logs
RUN mkdir -p /app/data

# Playwright: only Chromium is needed
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 3000

CMD ["node", "dist/index.js"]

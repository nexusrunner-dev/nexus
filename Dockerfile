FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

# Prisma needs OpenSSL present.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Build the backend (which lives in ./backend) from the repo root context.
COPY backend/package.json backend/package-lock.json* ./
RUN npm install --include=dev

COPY backend/prisma ./prisma
RUN npx prisma generate

COPY backend/tsconfig.json ./
COPY backend/src ./src

EXPOSE 8080
# Create/sync DB tables on boot, then start the app.
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && npm run start"]

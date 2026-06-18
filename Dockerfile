# ---- Stage 1: build the dashboard (frontend) ----
FROM node:20-slim AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
# No VITE_API_URL → the dashboard calls /api on its own origin (same server).
RUN npm run build

# ---- Stage 2: backend that also serves the dashboard ----
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY backend/package.json backend/package-lock.json* ./
RUN npm install --include=dev

COPY backend/prisma ./prisma
RUN npx prisma generate

COPY backend/tsconfig.json ./
COPY backend/src ./src

# Bundle the built dashboard so the backend can serve it at "/".
COPY --from=frontend /fe/dist ./public

EXPOSE 8080
# Create/sync DB tables on boot, then start the app (serves API + dashboard).
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && npm run start"]

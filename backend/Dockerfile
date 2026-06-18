FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

# Prisma needs OpenSSL present.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# --include=dev ensures prisma + tsx are present for generate/runtime even with NODE_ENV=production
RUN npm install --include=dev

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src

EXPOSE 8080
# Sync the schema to the database on boot (creates tables if missing), then start.
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && npm run start"]

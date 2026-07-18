# Stage 1: install deps + compile TS
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2: production runtime, prod deps only
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY src/views ./dist/views
COPY src/public ./dist/public
# alpine's node image ships a non-root `node` user (uid 1000) already
USER node
EXPOSE 8080
ENTRYPOINT ["node", "dist/index.js"]

FROM node:26-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY service-a/package.json ./service-a/package.json
COPY service-b/package.json ./service-b/package.json
RUN npm ci --omit=dev --no-audit --no-fund
COPY shared ./shared
COPY service-a ./service-a
WORKDIR /app/service-a
EXPOSE 3001
CMD ["npm", "start"]

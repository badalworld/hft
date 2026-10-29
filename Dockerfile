# Aiven Runtime container manifest — HFT trading bot
FROM node:22-alpine
WORKDIR /app

# Install all dependencies (tsx, vite, tailwind, typescript needed for build and start)
COPY package*.json ./
RUN npm ci

# Copy source and build frontend assets
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]

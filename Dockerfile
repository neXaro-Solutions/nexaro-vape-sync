FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js README.md .env.example ./

ENV NODE_ENV=production
ENV PORT=10000
ENV HEADLESS=true

EXPOSE 10000

CMD ["node", "server.js"]

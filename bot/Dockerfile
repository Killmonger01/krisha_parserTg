FROM node:20-alpine
WORKDIR /app
COPY bot/package.json ./
RUN npm install
COPY shared ./shared
COPY bot/ ./
CMD ["node", "bot.js"]

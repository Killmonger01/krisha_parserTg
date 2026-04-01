FROM node:20-alpine
WORKDIR /app
COPY parser/package.json ./
RUN npm install
COPY shared ./shared
COPY parser/ ./
CMD ["node", "parser.js"]

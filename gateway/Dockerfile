FROM node:20-alpine

WORKDIR /app

COPY package.json .
RUN npm install

# Copy source (will be overridden by bind mount in dev)
COPY . .

# nodemon watches /app for changes via bind mount
CMD ["npx", "nodemon", "index.js"]

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY db ./db
COPY public ./public
RUN mkdir -p /app/data && chown node /app/data
USER node
EXPOSE 3000
CMD ["node", "src/index.ts"]

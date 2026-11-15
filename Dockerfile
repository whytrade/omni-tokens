FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY web ./web
COPY skill ./skill
ENV HOST=0.0.0.0 PORT=8787 DATABASE_PATH=/data/tab.db
RUN mkdir /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]

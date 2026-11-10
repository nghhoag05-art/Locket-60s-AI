FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY backend ./backend
USER node
ENV DATA_DIR=/tmp/locket-ai-generated
EXPOSE 8787
CMD ["node", "backend/server.mjs"]

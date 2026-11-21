FROM node:22-alpine
WORKDIR /app
COPY package.json server.js cli.js ./
COPY public ./public
ENV HOST=0.0.0.0 PORTA=3000
EXPOSE 3000
USER node
CMD ["node", "server.js"]

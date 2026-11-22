FROM node:22-alpine
WORKDIR /app
COPY package.json server.js cli.js ./
COPY public ./public
# Pasta das contas de usuário; no compose vira um volume, que sobrevive a rebuilds.
RUN mkdir dados && chown node:node dados
ENV HOST=0.0.0.0 PORTA=3000
EXPOSE 3000
USER node
CMD ["node", "server.js"]

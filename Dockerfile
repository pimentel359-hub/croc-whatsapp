FROM node:20-slim

WORKDIR /app

# Instala ferramentas essenciais para os módulos criptográficos do Baileys
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install

COPY server.js ./

RUN mkdir -p auth_info_baileys

EXPOSE 3000

ENV PORT=3000

CMD ["node", "server.js"]

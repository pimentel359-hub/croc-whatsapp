FROM node:20-slim

WORKDIR /app

# Instala ferramentas essenciais e certificados SSL para o git
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

# Configura git para usar https seguro
RUN git config --global url."https://github.com/".insteadOf git:// && \
    git config --global url."https://github.com/".insteadOf ssh://git@github.com/

COPY package*.json ./

RUN npm install

COPY server.js ./

RUN mkdir -p auth_info_baileys

EXPOSE 3000

ENV PORT=3000

CMD ["node", "server.js"]

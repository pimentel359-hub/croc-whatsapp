FROM node:20-alpine

WORKDIR /app

# Instala dependências de produção
COPY package*.json ./
RUN npm install --production

# Copia o código do microserviço
COPY server.js ./

# Cria diretório para persistência da sessão Baileys
RUN mkdir -p auth_info_baileys

EXPOSE 3000

ENV PORT=3000

CMD ["node", "server.js"]

FROM mcr.microsoft.com/playwright:v1.64.0-noble
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
# Easypanel enruta el dominio al puerto 80 del contenedor
ENV PORT=80 HOME=/tmp MAX_SESSIONS=3 MAX_NUMBERS=200 IDLE_MIN=10
EXPOSE 80
CMD ["node", "server.js"]

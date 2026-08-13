# Team-Scouter web UI container.
FROM node:22-slim

WORKDIR /app

# Install deps (tsx runs the TypeScript directly, so we keep dev deps).
COPY package*.json ./
RUN npm ci

# App source.
COPY . .

# The datastore + xlsx + Google token live here — mount a PERSISTENT volume at
# /app/data on your host so they survive restarts/redeploys.
ENV STORE_PATH=/app/data/store.json \
    XLSX_PATH=/app/data/scouter.xlsx \
    GOOGLE_TOKEN_PATH=/app/data/google-token.json \
    PORT=8080
VOLUME ["/app/data"]
EXPOSE 8080

CMD ["npm", "run", "serve"]

# --- Audit Trail dashboard --------------------------------------------------
# Two stages: build the bundle with Node, then serve the static output from
# nginx. The runtime image contains no Node, no node_modules and no source -
# only the compiled assets and a config file.
FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js ./
COPY src ./src

# VITE_API_BASE_URL is deliberately left empty. nginx proxies /api and /health to
# the backend, so the browser only ever makes same-origin requests - the same
# arrangement the Vite dev proxy gives in development, which means CORS behaves
# identically in both and cannot become a production-only surprise.
ENV VITE_API_BASE_URL=""
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1

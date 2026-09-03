# --- Audit Trail API + projection worker -----------------------------------
# One image serves both processes. The worker is not a different application;
# it is the same container started with a different command, which is what makes
# "the worker is independently deployable" a fact about the deployment rather
# than a claim in a document.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

# Run as a non-root user. The image writes nothing outside /tmp: the Event Store
# is in MongoDB, and there is no upload path.
USER node

EXPOSE 4001

# The container is healthy when the API says its database, worker and monitor
# are up - not merely when the port is open.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]

# shuttle-server image (design §2.8.9). The image holds only the esbuild bundle: no npm, no
# node_modules. Build the bundle first, then build from the repository root:
#   node scripts/build.mjs server
#   docker build -f packages/server/Dockerfile -t shuttle-server:0.1.0 .
# State lives in the /data bind mount, never in the container layer.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    SHUTTLE_DATA=/data \
    SHUTTLE_PORT=8787 \
    NODE_OPTIONS="--max-old-space-size=384 --disable-warning=ExperimentalWarning"

WORKDIR /app
COPY dist/server/ /app/

# shuttle-admin on PATH for `docker exec shuttle-server shuttle-admin …` (design §2.8.4).
RUN printf '#!/bin/sh\nexec node /app/shuttle-admin.mjs "$@"\n' > /usr/local/bin/shuttle-admin \
 && chmod 755 /usr/local/bin/shuttle-admin \
 && mkdir -p /data && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# SIGTERM: sockets close 4503, hwm.json written, WAL checkpointed (stop_grace_period 20 s).
STOPSIGNAL SIGTERM
CMD ["node", "/app/shuttle-server.mjs"]

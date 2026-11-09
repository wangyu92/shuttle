# shuttle-headless image (design §6.1.11). Built from the esbuild bundle: no npm runs in the image.
# Build context: the repository root after `npm run build:headless` (dist/headless/ holds the bundle).
#   docker build -f packages/headless/Dockerfile -t shuttle-headless:0.1.0 .
# Pin the base image by digest at build time (>= 22.13 for unflagged node:sqlite):
#   FROM node:22-bookworm-slim@sha256:<digest>
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY dist/headless/ /app/
RUN ln -s /app/shuttle-headless.mjs /usr/local/bin/shuttle-headless && chmod +x /app/shuttle-headless.mjs
# The deploy script passes the host uid:gid that owns the data and state directories.
USER 1000:1000
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "/app/shuttle-headless.mjs"]
CMD ["sync", "--continuous", "--state", "/state"]

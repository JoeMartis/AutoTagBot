FROM node:20-bookworm-slim

# python3-pikepdf brings python3 + libqpdf transitively. Using the Debian
# package instead of pip avoids the externally-managed-environment dance
# and gets us a wheel-free, fully-built install in one step.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3-pikepdf \
    && rm -rf /var/lib/apt/lists/*

# The node:* images already ship a `node` user at uid 1000, which is what
# Hugging Face Spaces require. Reuse it instead of creating a new account.
USER node
ENV HOME=/home/node \
    PORT=7860 \
    NODE_ENV=production

WORKDIR /home/node/app

# Node deps first for layer caching.
COPY --chown=node package.json package-lock.json ./
RUN npm ci --omit=dev

# App code.
COPY --chown=node . .

EXPOSE 7860

CMD ["node", "server.js"]

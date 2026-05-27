FROM node:20-bookworm-slim

# python3-pikepdf brings python3 + libqpdf transitively. Using the Debian
# package instead of pip avoids the externally-managed-environment dance
# and gets us a wheel-free, fully-built install in one step.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3-pikepdf \
    && rm -rf /var/lib/apt/lists/*

# Hugging Face Spaces requires a non-root user with uid 1000.
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PORT=7860 \
    NODE_ENV=production

WORKDIR /home/user/app

# Node deps first for layer caching.
COPY --chown=user package.json package-lock.json ./
RUN npm ci --omit=dev

# App code.
COPY --chown=user . .

EXPOSE 7860

CMD ["node", "server.js"]

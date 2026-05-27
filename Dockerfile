FROM node:20-bookworm-slim

# pikepdf needs libqpdf; the pip wheel bundles it on amd64 but pull in the
# system runtime as a fallback for arm and to keep imports fast.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv \
        libqpdf-dev \
    && rm -rf /var/lib/apt/lists/*

# Hugging Face Spaces require a non-root user with uid 1000.
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    PORT=7860 \
    NODE_ENV=production

WORKDIR /home/user/app

# Python deps. --break-system-packages because Debian Bookworm marks the
# user site as externally-managed; we accept that here since the image
# is single-purpose.
RUN pip3 install --user --no-cache-dir --break-system-packages pikepdf

# Node deps first for layer caching.
COPY --chown=user package.json package-lock.json* ./
RUN npm ci --omit=dev

# App code.
COPY --chown=user . .

EXPOSE 7860

CMD ["node", "server.js"]

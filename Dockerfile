# Wadle — container image.
#
# Two reasons to run Wadle this way rather than bare metal:
#
#   1. Toolchains. mingw-w64 produces real Windows .exe files and devkitARM
#      produces real .gba ROMs. Without them those tiers degrade to inspection
#      and patching only — which Wadle reports honestly, but the container is
#      how you get the full set.
#   2. Isolation. Wadle executes code written by a language model. Process-level
#      limits (ulimit, process-group kill, unshare -n) are the second layer; the
#      container is the first.

FROM node:22-bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive \
    PNPM_HOME=/usr/local/pnpm \
    PATH=/usr/local/pnpm:/opt/devkitpro/devkitARM/bin:$PATH

# --- system packages ------------------------------------------------------
# Grouped by why they are here, so a future reader can tell what is safe to cut.
RUN apt-get update && apt-get install -y --no-install-recommends \
      # Wadle itself
      ca-certificates curl git python3 python3-pip xz-utils \
      # sandboxing
      util-linux procps \
      # language toolchains the build loop verifies against
      build-essential golang-go rustc cargo default-jdk php-cli ruby-full \
      # binary targets
      gcc-mingw-w64-x86-64 binutils-mingw-w64-x86-64 \
      # format conversion
      ffmpeg imagemagick pandoc p7zip-full zip unzip \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      # binary inspection helpers
      binutils file \
    && rm -rf /var/lib/apt/lists/*

# Pillow widens image conversion beyond the built-in PNG encoder.
RUN pip3 install --no-cache-dir --break-system-packages Pillow

# --- devkitARM (real .gba ROM output) -------------------------------------
# Pulled separately because it is not in Debian. If this layer is removed the
# GBA tier degrades to header patching and IPS/UPS/BPS generation, which still
# work — Wadle will say so in the capability report rather than fail late.
ARG DEVKITARM_VERSION=r62
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    if [ "$arch" = "amd64" ]; then \
      curl -fsSL -o /tmp/devkitARM.tar.xz \
        "https://github.com/devkitPro/buildscripts/releases/download/devkitARM_${DEVKITARM_VERSION}/devkitARM_${DEVKITARM_VERSION}-linux-x86_64.tar.xz" \
        && mkdir -p /opt/devkitpro \
        && tar -xJf /tmp/devkitARM.tar.xz -C /opt/devkitpro \
        && rm /tmp/devkitARM.tar.xz; \
    else \
      echo "devkitARM prebuilt binaries are x86_64 only; skipping on ${arch}."; \
    fi
ENV DEVKITARM=/opt/devkitpro/devkitARM \
    DEVKITPRO=/opt/devkitpro

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# --- application ----------------------------------------------------------
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @wadle/web build

# Generated code runs as this user, which owns nothing but the data directory.
RUN useradd --create-home --shell /bin/bash wadle \
    && mkdir -p /app/data \
    && chown -R wadle:wadle /app/data
USER wadle

ENV HOST=0.0.0.0 \
    PORT=5174 \
    DATA_DIR=/app/data

EXPOSE 5174 5200-5299

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5174)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "start"]

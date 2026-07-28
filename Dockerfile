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
#
# Build rule followed throughout: only something Wadle genuinely cannot run
# without may fail the build. Every capability the project describes as
# "degrades honestly" degrades at build time too, prints why, and lets the image
# finish. `pnpm doctor` then reports what this particular image can actually do.

FROM node:22-bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive \
    PNPM_HOME=/usr/local/pnpm \
    PATH=/usr/local/pnpm:/opt/devkitpro/devkitARM/bin:$PATH

# --- system packages, required --------------------------------------------
# Wadle will not start without these, so a failure here is a real build failure.
#   ca-certificates curl git   fetching and cloning
#   python3 python3-pip        the binary toolbox (PE/GBA/patches/PNG)
#   xz-utils                   archive handling
#   util-linux procps          unshare -n, process-group teardown
#   build-essential            native module compilation (better-sqlite3)
#   binutils file              binary inspection
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         ca-certificates curl git python3 python3-pip xz-utils \
         util-linux procps build-essential binutils file \
    && rm -rf /var/lib/apt/lists/*

# --- system packages, optional --------------------------------------------
# Language toolchains, binary targets and conversion tools. Each widens what the
# build loop can verify or convert; none is needed to boot. Installed as
# non-fatal groups so one unavailable package degrades a tier instead of
# destroying the image.
RUN set -eu; \
    apt-get update; \
    for group in \
      "golang-go rustc cargo default-jdk php-cli ruby-full" \
      "gcc-mingw-w64-x86-64 binutils-mingw-w64-x86-64" \
      "ffmpeg imagemagick pandoc p7zip-full zip unzip" \
      "libreoffice-writer libreoffice-calc libreoffice-impress" \
    ; do \
      if apt-get install -y --no-install-recommends $group; then \
        echo "optional tooling installed: $group"; \
      else \
        echo "WARNING: optional tooling unavailable, continuing without it: $group"; \
      fi; \
    done; \
    rm -rf /var/lib/apt/lists/*

# Pillow widens image conversion beyond the built-in PNG encoder, which keeps
# working without it.
RUN pip3 install --no-cache-dir --break-system-packages Pillow \
    || echo "WARNING: Pillow unavailable; image conversion falls back to the built-in PNG encoder."

# --- devkitARM (real .gba ROM output) -------------------------------------
# Not in Debian, and devkitPro's prebuilt archive URLs move between releases, so
# no URL is baked in: a hard-coded one that 404s fails every build of this image
# for a tier that is explicitly optional. Supply one to get the full GBA tier:
#
#   docker compose build --build-arg DEVKITARM_URL=https://…/devkitARM-linux-x86_64.tar.xz
#
# Without it, GBA support is header read/write plus IPS/UPS/BPS generation,
# which is how ROM hacks are actually made. `pnpm doctor` reports which you have.
ARG DEVKITARM_URL=""
RUN set -eu; \
    mkdir -p /opt/devkitpro; \
    arch="$(dpkg --print-architecture)"; \
    if [ -z "${DEVKITARM_URL}" ]; then \
      echo "devkitARM: no DEVKITARM_URL supplied; GBA tier is header patching + IPS/UPS/BPS."; \
    elif [ "$arch" != "amd64" ]; then \
      echo "devkitARM: prebuilt binaries are x86_64 only; skipping on ${arch}."; \
    elif curl -fsSL --retry 3 --retry-delay 2 -o /tmp/devkitARM.tar.xz "${DEVKITARM_URL}"; then \
      tar -xJf /tmp/devkitARM.tar.xz -C /opt/devkitpro; \
      rm -f /tmp/devkitARM.tar.xz; \
      echo "devkitARM: installed from ${DEVKITARM_URL}"; \
    else \
      rm -f /tmp/devkitARM.tar.xz; \
      echo "WARNING: devkitARM download failed (${DEVKITARM_URL}); continuing without it."; \
    fi
ENV DEVKITARM=/opt/devkitpro/devkitARM \
    DEVKITPRO=/opt/devkitpro

# --- pnpm ------------------------------------------------------------------
# The corepack bundled with a given Node image carries a fixed set of signing
# keys, and rejects package manager releases signed after them with "Cannot find
# matching keyid" — a failure that depends on the age of the base image rather
# than on anything in this repository. Updating corepack first avoids it;
# installing pnpm straight from the registry is the fallback.
ARG PNPM_VERSION=10.33.0
RUN npm install -g corepack@latest \
    && (corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
        || npm install -g "pnpm@${PNPM_VERSION}") \
    && pnpm --version

# --- application ----------------------------------------------------------
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY . .

# Built here, once, so starting a container never has to.
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

# start:server-only, not start. `pnpm start` runs the preflight and rebuilds the
# UI, which is wrong in a container twice over: the UI is already built above,
# and the rebuild would write into /app as a user with no rights to it.
CMD ["pnpm", "start:server-only"]

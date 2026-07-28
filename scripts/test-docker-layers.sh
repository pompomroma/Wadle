#!/bin/sh
# Exercise the RUN-layer shell logic from the Dockerfile without the base image.
#
# This exists because of a real failure: the devkitARM layer fetched a pinned
# URL with `curl -fsSL` under `set -eux`, that release moved, and from then on
# every `docker compose up --build` died on a 404 — for a toolchain the
# Dockerfile itself documents as optional.
#
# Stubs stand in for apt-get/curl/dpkg so each branch can be forced. What is
# under test is the exit status: an optional layer must return 0 even when the
# thing it installs is unavailable, and a required layer must still fail.
# Building the image is the only complete check; this catches the class of bug
# above in a second, without a registry pull.
set -u
BIN="$(mktemp -d)"; PATH="$BIN:$PATH"; export PATH
pass=0; fail=0
result() {
  if [ "$1" = "$2" ]; then pass=$((pass+1)); printf '  ok   %s (exit %s)\n' "$3" "$2";
  else fail=$((fail+1)); printf 'FAIL   %s (exit %s, wanted %s)\n' "$3" "$2" "$1"; fi
}

stub() { printf '#!/bin/sh\n%s\n' "$2" > "$BIN/$1"; chmod +x "$BIN/$1"; }
stub dpkg 'echo amd64'

# ---- optional apt group loop ------------------------------------------------
optional_layer() {
  set -eu
  apt-get update
  for group in "alpha beta" "gamma" ; do
    if apt-get install -y --no-install-recommends $group; then
      echo "optional tooling installed: $group"
    else
      echo "WARNING: optional tooling unavailable, continuing without it: $group"
    fi
  done
  rm -rf /var/lib/apt/lists/* 2>/dev/null || true
}

stub apt-get 'exit 0'
( optional_layer >/dev/null 2>&1 ); result 0 $? "optional apt group: all available"

stub apt-get 'case "$1" in update) exit 0;; *) exit 100;; esac'
( optional_layer >/dev/null 2>&1 ); result 0 $? "optional apt group: every group unavailable"

stub apt-get 'case "$*" in *gamma*) exit 100;; *) exit 0;; esac'
out=$( optional_layer 2>&1 ); result 0 $? "optional apt group: one group unavailable"
echo "$out" | grep -q "WARNING.*gamma" \
  && { pass=$((pass+1)); echo "  ok   the unavailable group is named in the warning"; } \
  || { fail=$((fail+1)); echo "FAIL   warning did not name the unavailable group"; }

# ---- devkitARM layer --------------------------------------------------------
devkit_layer() {
  DEVKITARM_URL="$1"
  set -eu
  mkdir -p /tmp/dkp-test
  arch="$(dpkg --print-architecture)"
  if [ -z "${DEVKITARM_URL}" ]; then
    echo "devkitARM: no DEVKITARM_URL supplied; GBA tier is header patching + IPS/UPS/BPS."
  elif [ "$arch" != "amd64" ]; then
    echo "devkitARM: prebuilt binaries are x86_64 only; skipping on ${arch}."
  elif curl -fsSL --retry 3 --retry-delay 2 -o /tmp/devkitARM.tar.xz "${DEVKITARM_URL}"; then
    tar -xJf /tmp/devkitARM.tar.xz -C /tmp/dkp-test
    rm -f /tmp/devkitARM.tar.xz
    echo "devkitARM: installed from ${DEVKITARM_URL}"
  else
    rm -f /tmp/devkitARM.tar.xz
    echo "WARNING: devkitARM download failed (${DEVKITARM_URL}); continuing without it."
  fi
}

stub curl 'exit 22'   # what curl -f returns on a 404
out=$( devkit_layer "" 2>&1 ); result 0 $? "devkitARM: no URL supplied (the default)"
echo "$out" | grep -q "IPS/UPS/BPS" \
  && { pass=$((pass+1)); echo "  ok   default explains the degraded GBA tier"; } \
  || { fail=$((fail+1)); echo "FAIL   default did not explain the degradation"; }

out=$( devkit_layer "https://example.invalid/gone.tar.xz" 2>&1 )
result 0 $? "devkitARM: supplied URL 404s (the bug that broke the build)"
echo "$out" | grep -q "WARNING: devkitARM download failed" \
  && { pass=$((pass+1)); echo "  ok   the 404 is reported, not swallowed"; } \
  || { fail=$((fail+1)); echo "FAIL   the 404 was silent"; }

stub dpkg 'echo arm64'
out=$( devkit_layer "https://example.invalid/x.tar.xz" 2>&1 )
result 0 $? "devkitARM: non-amd64 host skips cleanly"
stub dpkg 'echo amd64'

# A real archive must still install, or the layer is uselessly permissive.
mkdir -p "$BIN/fixture/devkitARM/bin" && echo x > "$BIN/fixture/devkitARM/bin/arm-none-eabi-gcc"
tar -cJf "$BIN/dk.tar.xz" -C "$BIN/fixture" devkitARM
stub curl 'while [ $# -gt 0 ]; do case "$1" in -o) shift; dest="$1";; esac; shift; done; cp "'"$BIN"'/dk.tar.xz" "$dest"'
rm -rf /tmp/dkp-test
out=$( devkit_layer "https://example.test/dk.tar.xz" 2>&1 ); result 0 $? "devkitARM: a working URL installs"
[ -f /tmp/dkp-test/devkitARM/bin/arm-none-eabi-gcc ] \
  && { pass=$((pass+1)); echo "  ok   the toolchain is actually unpacked"; } \
  || { fail=$((fail+1)); echo "FAIL   nothing was unpacked"; }

# ---- required layer must still be fatal ------------------------------------
stub apt-get 'case "$1" in update) exit 0;; *) exit 100;; esac'
( set -e; apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /x ) >/dev/null 2>&1
[ $? -ne 0 ] \
  && { pass=$((pass+1)); echo "  ok   the REQUIRED apt layer still fails the build"; } \
  || { fail=$((fail+1)); echo "FAIL   required packages no longer fail the build"; }

rm -rf "$BIN" /tmp/dkp-test
printf '\n%s/%s layer checks passed\n' "$pass" "$((pass+fail))"
[ "$fail" -eq 0 ]

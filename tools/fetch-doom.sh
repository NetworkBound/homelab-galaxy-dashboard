#!/usr/bin/env bash
# fetch-doom.sh — download the optional DOOM takeover assets into static/doom/.
#
# WHY THIS IS A SCRIPT AND NOT A DIRECTORY IN THE REPO
#   js-dos (the DOSBox-in-WebAssembly runtime) and the DOOM shareware bundle are
#   ~14 MB together and neither is ours to redistribute. static/doom/ is
#   gitignored; static/doom.js HEAD-checks js-dos.js once at start and disables
#   itself cleanly when it is not there, so the dashboard is perfectly happy
#   without ever running this.
#
# WHAT IT FETCHES
#   js-dos 6.22            js-dos.js, wdosbox.js, wdosbox.wasm.js  (MIT)
#     pinned to npm js-dos@6.22.60 via jsDelivr, falling back to js-dos.com.
#   DOOM shareware         doom-sw.zip  (id Software, freely redistributable
#     *unmodified* under the original shareware licence — it is NOT free
#     software and it is NOT in this repo).
#     The zip is repacked so everything sits under DOOM/, because doom.js runs
#     `cd DOOM` then `DOOM.EXE -warp 1 1 -skill 3` inside the emulator.
#
# Every URL is probed with `curl -sI` before anything is downloaded; if no WAD
# source answers, js-dos is still installed and the script prints exactly how to
# supply the bundle by hand. Re-running is safe: existing files are replaced.
#
# Usage:  tools/fetch-doom.sh [target-dir]        (default: static/doom)
#         FORCE=1 tools/fetch-doom.sh             re-download even if present
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$ROOT/static/doom}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_bad=$'\033[31m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s  ok%s  %s\n'   "$c_ok"   "$c_off" "$*"; }
warn() { printf '%s  ..%s  %s\n'   "$c_warn" "$c_off" "$*"; }
bad()  { printf '%s  !!%s  %s\n'   "$c_bad"  "$c_off" "$*"; }
dim()  { printf '%s%s%s\n'         "$c_dim"  "$*"     "$c_off"; }

need() { command -v "$1" >/dev/null 2>&1 || { bad "missing required tool: $1"; exit 1; }; }
need curl
need unzip
need zip

# HEAD the URL and answer 0 only for a 2xx. -L so a redirect to the real CDN counts.
probe() {
  local code
  code="$(curl -sI -L -m 20 -o /dev/null -w '%{http_code}' "$1" || echo 000)"
  [ "$code" = "200" ]
}

# Try each URL in turn; the first one that both probes and downloads non-empty wins.
fetch_first() {
  local out="$1"; shift
  local url
  for url in "$@"; do
    if ! probe "$url"; then
      dim "    probe failed: $url"
      continue
    fi
    if curl -fsSL -m 300 "$url" -o "$out" && [ -s "$out" ]; then
      dim "    from $url"
      return 0
    fi
    dim "    download failed: $url"
  done
  return 1
}

mkdir -p "$DEST"
say ""
say "DOOM assets -> $DEST"
say ""

# ------------------------------------------------------------------ js-dos ---
JSDOS_CDN="https://cdn.jsdelivr.net/npm/js-dos@6.22.60/dist"
JSDOS_ALT="https://js-dos.com/6.22/current"
say "js-dos 6.22 (MIT)"
jsdos_ok=1
for f in js-dos.js wdosbox.js wdosbox.wasm.js; do
  if [ -s "$DEST/$f" ] && [ -z "${FORCE:-}" ]; then
    ok "$f (already present — FORCE=1 to re-download)"
    continue
  fi
  if fetch_first "$TMP/$f" "$JSDOS_CDN/$f" "$JSDOS_ALT/$f"; then
    mv "$TMP/$f" "$DEST/$f"
    ok "$f ($(wc -c <"$DEST/$f") bytes)"
  else
    bad "$f could not be fetched"
    jsdos_ok=0
  fi
done

# ------------------------------------------------------------- shareware ---
# The original 1.9 shareware archive: DOOM.EXE + DOOM1.WAD + the text files.
WAD_SOURCES=(
  "https://archive.org/download/DoomsharewareEpisode/doom.ZIP"
  "https://archive.org/download/doom-shareware-1.9/doom19s.zip"
)
say ""
say "DOOM shareware bundle (id Software — redistributable unmodified, not free software)"
wad_ok=0
if [ -s "$DEST/doom-sw.zip" ] && [ -z "${FORCE:-}" ]; then
  ok "doom-sw.zip (already present — FORCE=1 to re-download)"
  wad_ok=1
elif fetch_first "$TMP/src.zip" "${WAD_SOURCES[@]}"; then
  if unzip -qq -o "$TMP/src.zip" -d "$TMP/raw" 2>/dev/null &&
     [ -n "$(find "$TMP/raw" -iname 'doom1.wad' -print -quit)" ]; then
    # repack under DOOM/ so the emulator's `cd DOOM` finds it, and normalise the
    # file names to upper case the way DOS expects them
    mkdir -p "$TMP/pack/DOOM"
    find "$TMP/raw" -type f -print0 | while IFS= read -r -d '' p; do
      n="$(basename "$p" | tr '[:lower:]' '[:upper:]')"
      cp "$p" "$TMP/pack/DOOM/$n"
    done
    ( cd "$TMP/pack" && zip -qr "$TMP/doom-sw.zip" DOOM )
    mv "$TMP/doom-sw.zip" "$DEST/doom-sw.zip"
    ok "doom-sw.zip ($(wc -c <"$DEST/doom-sw.zip") bytes, repacked under DOOM/)"
    wad_ok=1
  else
    bad "downloaded archive does not contain DOOM1.WAD"
  fi
else
  warn "no shareware source answered"
fi

# ------------------------------------------------------------------- done ---
say ""
if [ "$jsdos_ok" = 1 ] && [ "$wad_ok" = 1 ]; then
  ok "DOOM is installed. Restart the dashboard so /api/config reports features.doom,"
  say "     then type IDDQD on the wall (or open /?doom=1) to trigger the takeover."
  exit 0
fi

if [ "$jsdos_ok" != 1 ]; then
  bad "js-dos is missing, so the takeover stays disabled."
  say "     Download these three files into $DEST by hand:"
  say "       $JSDOS_CDN/js-dos.js"
  say "       $JSDOS_CDN/wdosbox.js"
  say "       $JSDOS_CDN/wdosbox.wasm.js"
fi

if [ "$wad_ok" != 1 ]; then
  warn "The shareware bundle is missing. Supply it by hand:"
  say ""
  say "  1. Get the DOOM 1.9 shareware archive. Any of these work — it is the"
  say "     same 2.4 MB archive id Software has always allowed to be passed around:"
  say "       * https://archive.org/details/DoomsharewareEpisode  (file doom.ZIP)"
  say "       * any 'doom19s.zip' / 'dm19s*.zip' mirror"
  say "       * an existing DOOM install you own: you need DOOM.EXE and DOOM1.WAD"
  say "  2. Build $DEST/doom-sw.zip with everything inside a DOOM/ directory:"
  say ""
  say "       mkdir -p DOOM && cp /path/to/DOOM.EXE /path/to/DOOM1.WAD DOOM/"
  say "       zip -r $DEST/doom-sw.zip DOOM"
  say ""
  say "     doom.js runs 'cd DOOM' then 'DOOM.EXE -warp 1 1 -skill 3' inside the"
  say "     emulator, so that directory name matters."
  say "  3. Restart the dashboard."
  say ""
  say "  Do NOT commit the result: static/doom/ is gitignored on purpose."
fi
exit 1

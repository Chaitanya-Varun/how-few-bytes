#!/bin/bash
# Game night on the laptop: starts the FlexTok decoder, the game server and a public
# Cloudflare tunnel, then prints the link to share. Ctrl-C stops all three.
#   scripts/play.sh              FlexTok + tunnel
#   scripts/play.sh --no-flextok stand-in decoder only (starts instantly)
#   scripts/play.sh --local      no tunnel, just http://localhost:8787
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${FLEXTOK_PYTHON:-$HOME/miniforge3/envs/IF_py3p11/bin/python}"
PORT="${PORT:-8787}"
FLEXTOK=1 TUNNEL=1
for a in "$@"; do
	case "$a" in
		--no-flextok) FLEXTOK=0 ;;
		--local) TUNNEL=0 ;;
		*) echo "unknown option $a"; exit 1 ;;
	esac
done
trap 'kill $(jobs -p) 2>/dev/null' EXIT

if [ "$FLEXTOK" = 1 ]; then
	echo "Loading FlexTok (about a minute; the game runs on the stand-in until it's ready)..."
	HF_HUB_OFFLINE=1 "$PY" decoder/flextok_server.py 2> >(grep -v -e Warning -e posembs >&2) &
fi
PORT="$PORT" node server/local.js &

if [ "$TUNNEL" = 1 ]; then
	cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" 2>&1 |
		grep --line-buffered -oE 'https://[a-z0-9-]+\.trycloudflare\.com' |
		while read -r url; do printf '\n  Share this link with the players:  %s\n\n' "$url"; done &
fi
wait

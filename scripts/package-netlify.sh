#!/bin/bash
# Builds netlify-ready-game.zip for Netlify Drop (app.netlify.com/drop): the static page,
# the game function, the shared rules and the lockfile. No node_modules, server or decoder.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -f netlify-ready-game.zip
zip -rq netlify-ready-game.zip netlify.toml package.json package-lock.json public shared netlify -x '*.DS_Store'
unzip -l netlify-ready-game.zip | tail -n +4 | sed '$d' | sed '$d' | awk '{print "  " $4}'
echo "wrote $(pwd)/netlify-ready-game.zip"

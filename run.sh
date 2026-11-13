#!/bin/sh
# Start Sold to Covered on this Mac. It is a static page; this only serves the folder locally.
set -eu
cd "$(dirname "$0")"
[ -f site/data/orders.json ] || python3 generate.py
PORT="${PORT:-5110}"
echo "Sold to Covered: http://127.0.0.1:$PORT/"
exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory site

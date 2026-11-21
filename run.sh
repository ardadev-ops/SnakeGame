#!/usr/bin/env bash
#
# Baut und startet die Snake-Webapplikation (nur JDK 21+, keine Abhaengigkeiten).
#
set -euo pipefail

cd "$(dirname "$0")"

OUT="out"
rm -rf "$OUT"
mkdir -p "$OUT"

find src -name '*.java' -print0 | xargs -0 javac -encoding UTF-8 -d "$OUT"

exec java -cp "$OUT" snake.Main "$@"

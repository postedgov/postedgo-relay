#!/bin/sh
set -eu
cd -- "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PATH="$HOME/.local/bin:$HOME/.kimi-code/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export PATH
exec node src/launch.mjs "$@"

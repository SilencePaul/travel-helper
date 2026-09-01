#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: pnpm briefing:publish -- <source.html> <slug>" >&2
  exit 2
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"
node_bin="${TRAVEL_NODE:-node}"
source_file="$1"
slug="$2"
target="apps/web/public/briefings/${slug}/index.html"

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "ERROR: briefing publishing only runs from main." >&2
  exit 1
fi

"$node_bin" scripts/publish-briefing.mjs "$source_file" "$slug"
"$node_bin" scripts/build-web-cloudflare.mjs

if [[ ! -f "apps/web/dist/briefings/${slug}/index.html" ]] || ! cmp -s "$target" "apps/web/dist/briefings/${slug}/index.html"; then
  echo "ERROR: built briefing does not match the prepared source." >&2
  exit 1
fi

if ! git diff --quiet -- "$target" || ! git ls-files --error-unmatch "$target" >/dev/null 2>&1; then
  git add -- "$target"
  git commit --only -m "docs: publish briefing ${slug}" -- "$target"
fi

git push origin main
printf '\nPublished briefing: https://trip.yiming.ca/briefings/%s/\n' "$slug"

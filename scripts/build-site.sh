#!/usr/bin/env sh
# build-site.sh — assemble the static bundle that is uploaded to the Cloudflare
# Worker (Workers & Pages → timbswap → New deployment → upload zip, Production).
#
#   sh scripts/build-site.sh            → dist/timbswap-site-<sha>.zip
#
# Contents: every page and asset the site serves, plus
#   keepers.tgz            scripts/ without node_modules — the Railway services
#                          fetch this at start (see scripts/RAILWAY.md)
#   timbswap-source.zip    contracts + policy + specs, linked from /source/
#   contracts/, *.md, LICENSE   served as text so /source/ can link to them
#
# Run from the repo root on a clean checkout of main. Needs git, tar, zip.
set -eu
cd "$(dirname "$0")/.."
sha=$(git rev-parse --short HEAD)
out=dist; stage=$out/site; rm -rf "$stage"; mkdir -p "$stage"

# 1. site files: everything git tracks except code, CI, docs-for-devs, tests
git ls-files -z | grep -zvE '^(scripts/|tests?/|script/|lib/|dev-docs/|supabase/|\.github/|\.devcontainer/|workers/|\.[a-z]|foundry\.|remix\.config|slither\.config|package(-lock)?\.json|hardhat\.config|env\.)' \
  | xargs -0 -I{} sh -c 'mkdir -p "$1/$(dirname "{}")" && cp "{}" "$1/{}"' _ "$stage"

# 2. keepers for Railway
tmp=$(mktemp -d); git archive HEAD scripts | tar x -C "$tmp"; rm -rf "$tmp/scripts/node_modules"
tar czf "$stage/keepers.tgz" -C "$tmp" scripts; rm -rf "$tmp"

# 3. source download
tmp=$(mktemp -d); git archive HEAD contracts foundry.toml SECURITY.md SPECS.md ROADMAP.md README.md CHANGELOG.md LICENSE | tar x -C "$tmp"
( cd "$tmp" && zip -qr "$OLDPWD/$stage/timbswap-source.zip" . ); rm -rf "$tmp"

# 4. pin the commit shown on /source/
sed -i "s/SOURCE · [0-9a-f]\{7,\}/SOURCE · $sha/; s/at commit <code>[0-9a-f]\{7,\}<\/code>/at commit <code>$sha<\/code>/g" "$stage/source/index.html"

( cd "$stage" && rm -f "../timbswap-site-$sha.zip" && zip -qr "../timbswap-site-$sha.zip" . )
echo "$out/timbswap-site-$sha.zip  ($(unzip -l "$out/timbswap-site-$sha.zip" | tail -1))"

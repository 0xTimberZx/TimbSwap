#!/usr/bin/env sh
# build-site.sh — assemble the static bundle that is uploaded to the Cloudflare
# Worker (Workers & Pages → timbswap → New deployment → upload zip, Production).
#
#   sh scripts/build-site.sh            → dist/timbswap-site-<sha>.zip        (Arbitrum Sepolia)
#   NET=mainnet sh scripts/build-site.sh → dist/timbswap-site-mainnet-<sha>.zip (Arbitrum One beta:
#                                          config.mainnet.js is prepended to config.js; see that file)
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
net=${NET:-sepolia}
case "$net" in sepolia) tag=$sha ;; mainnet) tag="mainnet-$sha" ;; *) echo "NET must be sepolia or mainnet" >&2; exit 2 ;; esac
# mainnet: refuse while any beta contract in config.mainnet.js is still a
# placeholder — a zero address there would make the live site call address(0).
if [ "$net" = mainnet ] && grep -qE '"0x0{40}",? *// beta' config.mainnet.js; then
  echo "config.mainnet.js still has a zero beta address — fill in the DeployBeta output first" >&2; exit 3
fi
out=dist; stage=$out/site; rm -rf "$stage"; mkdir -p "$stage"

# 1. site files: everything git tracks except code, CI, docs-for-devs, tests
git ls-files -z | grep -zvE '^(scripts/|tests?/|script/|lib/|dev-docs/|supabase/|\.github/|\.devcontainer/|workers/|\.[a-z]|foundry\.|remix\.config|slither\.config|package(-lock)?\.json|hardhat\.config|env\.)' \
  | xargs -0 -I{} sh -c 'mkdir -p "$1/$(dirname "{}")" && cp "{}" "$1/{}"' _ "$stage"

# 2. keepers for Railway
tmp=$(mktemp -d); git archive HEAD scripts | tar x -C "$tmp"; rm -rf "$tmp/scripts/node_modules"
tar czf "$stage/keepers.tgz" -C "$tmp" scripts; rm -rf "$tmp"

# 3. source download
# (git ls-files drops any of these the repo doesn't have — this mirror has no
#  SPECS.md/CHANGELOG.md, and git archive would abort on a missing pathspec.)
tmp=$(mktemp -d)
git ls-files -z -- contracts foundry.toml SECURITY.md SPECS.md ROADMAP.md README.md CHANGELOG.md LICENSE MAINNET_ADDRESSES.md \
  | xargs -0 git archive HEAD | tar x -C "$tmp"
( cd "$tmp" && zip -qr "$OLDPWD/$stage/timbswap-source.zip" . ); rm -rf "$tmp"

# 3b. mainnet: prepend the network override so every page's single config.js
#     script tag (and the keepers' regex read of it) sees Arbitrum One first.
if [ "$net" = mainnet ]; then
  cat config.mainnet.js "$stage/config.js" > "$stage/config.js.tmp" && mv "$stage/config.js.tmp" "$stage/config.js"
  rm -f "$stage/config.mainnet.js"
  # Static text crawlers read without JS: <meta>/<title> descriptions, explorer
  # and Sourcify URLs. Visible copy is handled at runtime (config.js netCopy).
  find "$stage" -name '*.html' -print0 | xargs -0 sed -i \
    -e '/<meta\|<title/ s/get free testnet gas and tokens, then play. Free on Arbitrum Sepolia testnet./get a little ETH, pick a ticket, then play. Capped beta on Arbitrum One./g' \
    -e '/<meta\|<title/ s/Free to try on Arbitrum testnet./Play the capped beta on Arbitrum One./g' \
    -e '/<meta\|<title/ s/on the Arbitrum Sepolia testnet DEX/on Arbitrum One/g' \
    -e '/<meta\|<title/ s/Arbitrum Sepolia testnet/Arbitrum One/g' \
    -e '/<meta\|<title/ s/on Arbitrum Sepolia/on Arbitrum One/g' \
    -e '/<meta\|<title/ s/testnet bug bounty/bug bounty/g' \
    -e '/<meta\|<title/ s/a testnet TIMBS drip/an ETH drip/g' \
    -e '/<meta\|<title/ s/free testnet entry/free entry/g' \
    -e '/<meta\|<title/ s/get free testnet gas and tokens, then play. Free on Arbitrum One./get a little ETH, pick a ticket, then play. Capped beta on Arbitrum One./g' \
    -e 's#https://sepolia.arbiscan.io/address/0xCCd6d3f0A86042d2B7056eDd381d367126628AF5#https://arbiscan.io/address/0x60d4f18fe205c0ed38507a8fbf89aaa1bd2ce183#g' \
    -e 's#https://sepolia.arbiscan.io#https://arbiscan.io#g' \
    -e 's#https://repo.sourcify.dev/421614/#https://repo.sourcify.dev/42161/#g'
fi

# 4. pin the commit shown on /source/
sed -i "s/SOURCE · [0-9a-f]\{7,\}/SOURCE · $sha/; s/at commit <code>[0-9a-f]\{7,\}<\/code>/at commit <code>$sha<\/code>/g" "$stage/source/index.html"

( cd "$stage" && rm -f "../timbswap-site-$tag.zip" && zip -qr "../timbswap-site-$tag.zip" . )
echo "$out/timbswap-site-$tag.zip  ($(unzip -l "$out/timbswap-site-$tag.zip" | tail -1))"

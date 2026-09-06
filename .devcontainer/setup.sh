#!/usr/bin/env bash
# Codespace bootstrap for TimbSwap: installs the Foundry toolchain and pulls the
# Solidity submodules so `forge test` works immediately in any new Codespace.
# Runs once on Codespace creation (postCreateCommand).
set -euo pipefail

# 1. Foundry (forge / cast / anvil). The installer drops `foundryup` into
#    ~/.foundry/bin and adds it to the shell profile for interactive terminals.
if ! command -v forge >/dev/null 2>&1; then
  echo "Installing Foundry..."
  curl -L https://foundry.paradigm.xyz | bash
fi
"$HOME/.foundry/bin/foundryup"

# 2. Solidity dependencies (forge-std, openzeppelin-contracts) live as git
#    submodules — without these, forge can't resolve imports.
git submodule update --init --recursive

# 3. JS deps for scripts/ (ethers, etc.), only if a manifest is present.
if [ -f package.json ]; then
  npm install
fi

echo "✓ TimbSwap ready — run: forge test -vvv"

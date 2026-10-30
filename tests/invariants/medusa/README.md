# Medusa harnesses for the invariant suites

A second, coverage-guided fuzzer over the same handlers and checks as the forge
invariant suites in `tests/invariants/`. Each harness builds its forge suite,
forwards every handler action, and exposes each `invariant_*` check as a
`property_*` (a failing forge assert reverts, which the harness reports as
`false`). Nothing here duplicates a handler or a check.

| Harness | Forge suite | Config |
|---|---|---|
| `GameMedusa` | `GameInvariants` | `medusa.game.json` |
| `PairMedusa` | `PairInvariants` | `medusa.pair.json` |
| `SupplyAndYieldMedusa` | `SupplyAndYieldInvariants` | `medusa.supply.json` |

## Run

From the repo root:

```sh
forge build --build-info --out out-medusa tests/invariants/medusa
medusa fuzz --config tests/invariants/medusa/medusa.pair.json            # 30 min
medusa fuzz --config tests/invariants/medusa/medusa.pair.json --timeout 60  # smoke
```

The configs read the prebuilt `out-medusa` (`--foundry-ignore-compile`), so
rebuild it after any contract or test change. Corpora and coverage land in
`corpus-*/` (gitignored); keep them between runs so Medusa resumes from them.

`VaultHandler.overWithdraw` relies on `vm.expectRevert`, which Medusa does not
implement, so that one action always reverts under Medusa; the forge suite
covers it.

For long forge runs of the same suites: `FOUNDRY_PROFILE=deep forge test
--match-path 'tests/invariants/*'` (1,000 runs × 500 calls).

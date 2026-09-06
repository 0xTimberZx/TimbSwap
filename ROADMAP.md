# TimbSwap Roadmap

Stated plainly, and separated into *shipped*, *next*, and *vision* — so it's clear what exists
today versus where the protocol is headed. Nothing here is a promise of returns; TimbSwap is an
experimental testnet project (see [Risks](https://timbswap.xyz/docs/#risks)).

---

## Now — live on Arbitrum Sepolia

The full incentive engine runs end-to-end, unattended.

- **AMM core** — Factory, Router (v8), pairs; ETH auto-wrapping; add/remove liquidity.
- **Prize game** — round-based, permissionless settlement, generation epochs, yield-funded pot,
  4-round principal refund window, 2-round claim window, block-hash jitter.
- **SwapTables** — pari-mutuel roulette on play-chips, seven pools a table, graduated rake,
  monotonic underwrite from a solvency-capped reserve, and a cross-generation rolling jackpot.
  Nine board generations shipped; contracts verified `exact_match` on Sourcify.
- **Emissions** — single-asset staking, LP farm, boosted farms, all on the epoch waterfall with a
  99% solvency stop and self-retargeting rates.
- **Autonomy** — a GitHub Actions keeper settles segments every ~10 min and runs the reward sweep
  every 6 rounds, with Telegram/X notifications.
- **Transparency** — static frontend reading live chain state; contracts verified on Sourcify;
  public docs, address table, and DebugHub telemetry.

## Next — the road to mainnet

Gated on evidence and safety, not a calendar.

1. **Engagement signal** — sustained active wallets across many settled rounds, repeat-play, and
   eligible swap volume that tracks round activity. Testnet's job is to manufacture this proof.
2. **Security** — independent audit of the contract set; a published security policy and
   disclosure process. **The audit is a hard gate before any real-value deployment.**
3. **Legal** — formal counsel on the prize mechanic and likely jurisdiction geofencing — also a
   gate, not an afterthought.
4. **Depth** — seeded liquidity and an initial prize pot so early mainnet rounds are worth
   playing before organic fees and yield carry them.
5. **Instrumentation** — turn the existing telemetry (liquidity depth, swaps, staking, treasury
   health) into live signals and dashboards.
6. **Ticket-cost equilibrium** — finalize the late-game structure so ticket costs settle at a
   market equilibrium: priced high enough to fund a meaningful pot and deter spam, low enough that
   late-round entry stays rational as the pot and odds shift. Tune against observed testnet play
   before mainnet locks it in.

## Vision — adaptive incentives

Stated as direction, **not** a capability claimed today.

The allocation cycle is deliberately rule-based and solvency-bounded right now — predictable and
auditable. The same telemetry that proves solvency is the substrate for a future **adaptive
policy**: incentives that tune to observed protocol health, still on-chain, still transparent,
still bounded by the identical guardrails (fixed supply, solvency stop, non-custodial). The
ambition grows; the discipline does not move.

---

### The graduation gate

> We deploy to mainnet when engagement is **proven** and the security and legal gates are
> **cleared** — never before. Until then, everything here is a test asset with no value, and the
> point of the exercise is to earn the evidence.

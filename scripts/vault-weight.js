// vault-weight.js
// TimbYieldVault weight auditor / drainer.
//
// WHY THIS EXISTS
// ---------------
// GameRegistry allocates ticket ids from `nextTicketId`, which every fresh
// deployment initialises to 1. The vault keys `weightOf` by that raw id with
// no registry namespace. So after a registry cutover, v(N) ticket #3 and
// v(N+1) ticket #3 are the same storage slot, and two things go wrong:
//
//   1. Weight registered by the OLD registry can never be removed by it —
//      `remove()` is onlyGameRegistry and the pointer has moved on. That
//      weight is stranded, and since _accrue() computes
//        pending = totalWeight * ratePerSecond1e18 / 1e18 * elapsed
//      against the vault's own ETH balance, phantom weight drains the
//      subsidy reserve faster than real participation justifies.
//
//   2. `register()` opens with `if (weightOf[ticketId] != 0) return;` — so a
//      NEW ticket landing on a still-occupied slot is silently skipped and
//      earns nothing. GameRegistry wraps the call in try/catch, so nothing
//      surfaces at settlement either.
//
// Cleaning this up by hand means reading weightOf across an unknown id range
// in Remix one call at a time. That is what this script replaces.
//
// USAGE
//   node vault-weight.js                     # audit only — never sends a tx
//   node vault-weight.js --drain             # audit, then remove stranded ids
//   node vault-weight.js --drain --ids 3,7,9 # remove an explicit list
//
// Draining requires the vault's `gameRegistry` to point at the signer, since
// `remove()` is onlyGameRegistry. The script refuses to send otherwise, and
// ALWAYS prints the restore command on exit — leaving the pointer parked on
// an EOA is the failure mode that motivated point 2 above.

const { ethers } = require("ethers");

// ─── Config ──────────────────────────────────────────────────────────────────

const RPC  = process.env.RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc";
const VAULT = process.env.VAULT_ADDR    || "0x43D833e828e2AF951527C2b573Eb70c358FfEB0B";
const REGISTRY = process.env.REGISTRY_ADDR || "0xBAb1CBaF0dE094322A49B379d0AC4510D1F78530";
const KEY  = process.env.LP_PRIVATE_KEY || process.env.PRIVATE_KEY || "";

// Scan ceiling when the registry's own nextTicketId can't be read, or when the
// old registry's id space ran past the current one.
const SCAN_MAX = Number(process.env.SCAN_MAX || "0");

const VAULT_ABI = [
  "function weightOf(uint256) view returns (uint256)",
  "function totalWeight() view returns (uint256)",
  "function gameRegistry() view returns (address)",
  "function remove(uint256)",
  "function setGameRegistry(address)",
];

const REGISTRY_ABI = [
  "function nextTicketId() view returns (uint256)",
  // Flattened public getter for `mapping(uint256 => Ticket) public tickets`.
  // Field order must track GameRegistry.sol's struct exactly.
  "function tickets(uint256) view returns (uint256 id, address owner, bytes6 string6, uint256 playRound, uint256 lastEligibleRound, uint256 escrowAmount, address escrowToken, uint8 status, uint256 supersedes, uint256 supersededBy, uint256 createdAt, uint256 forfeitRound, uint256 generation)",
];

// ─── Args ────────────────────────────────────────────────────────────────────

const argv  = process.argv.slice(2);
const DRAIN = argv.includes("--drain");
const idsArg = (() => {
  const i = argv.indexOf("--ids");
  if (i === -1 || !argv[i + 1]) return null;
  return argv[i + 1].split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
})();

const fmt = (wei) => `${ethers.formatEther(wei)} ETH-eq`;

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const vault    = new ethers.Contract(VAULT, VAULT_ABI, provider);

  const [totalWeight, pointer] = await Promise.all([
    vault.totalWeight(),
    vault.gameRegistry(),
  ]);

  console.log(`vault        ${VAULT}`);
  console.log(`totalWeight  ${totalWeight} (${fmt(totalWeight)})`);
  console.log(`gameRegistry ${pointer}`);

  // Bound the scan. nextTicketId is the exclusive upper bound of the CURRENT
  // registry's id space; a retired registry may have issued more, so SCAN_MAX
  // can push the ceiling higher.
  let ceiling = SCAN_MAX;
  try {
    const reg = new ethers.Contract(REGISTRY, REGISTRY_ABI, provider);
    const next = Number(await reg.nextTicketId());
    console.log(`nextTicketId ${next} (current registry)`);
    ceiling = Math.max(ceiling, next);
  } catch {
    console.log(`nextTicketId unreadable — falling back to SCAN_MAX=${SCAN_MAX}`);
  }
  if (!ceiling) throw new Error("no scan ceiling: set SCAN_MAX or make the registry readable");

  // Ids start at 1. Scan in batches so a wide range stays one burst of calls
  // rather than a serial crawl.
  const ids = [];
  for (let id = 1; id <= ceiling; id++) ids.push(id);

  const held = [];
  const BATCH = 40;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const weights = await Promise.all(slice.map((id) => vault.weightOf(id)));
    slice.forEach((id, k) => {
      if (weights[k] > 0n) held.push({ id, weight: weights[k] });
    });
    process.stdout.write(`\rscanned ${Math.min(i + BATCH, ids.length)}/${ids.length}`);
  }
  console.log("");

  const sum = held.reduce((a, h) => a + h.weight, 0n);
  console.log(`\n${held.length} id(s) holding weight, summing ${sum} (${fmt(sum)})`);
  for (const h of held) console.log(`  #${h.id}  ${h.weight}`);

  if (sum !== totalWeight) {
    // The scan missed something — almost always a retired registry whose id
    // space ran past the current nextTicketId. Raise SCAN_MAX and re-run.
    console.log(
      `\n! scan sum != totalWeight (short by ${totalWeight - sum}). ` +
      `Ids exist above ${ceiling}; re-run with SCAN_MAX set higher.`
    );
  }

  // Cross-reference the live registry so we only ever propose removing ids it
  // does NOT recognise as an active ticket. An id the current registry still
  // owns will be removed by the registry itself at expiry.
  //
  // This deliberately errs toward LEAVE: where a stranded old id COLLIDES with
  // a live new one, the slot reads as live and we skip it. That costs some
  // lingering phantom weight, which is a slow subsidy leak — versus deleting a
  // real ticket's weight, which robs a player of yield. Take the leak.
  const stranded = [];
  try {
    const reg = new ethers.Contract(REGISTRY, REGISTRY_ABI, provider);
    for (const h of held) {
      const t = await reg.tickets(h.id);
      const live = t.owner !== ethers.ZeroAddress;
      if (!live) stranded.push(h);
      console.log(`  #${h.id}  ${live ? "live in current registry — LEAVE" : "not in current registry — STRANDED"}`);
    }
  } catch {
    console.log("\n! could not cross-reference the registry; treating nothing as stranded");
  }

  if (!DRAIN) {
    console.log(`\naudit only. ${stranded.length} stranded id(s). Re-run with --drain to remove.`);
    return;
  }

  const targets = idsArg ? held.filter((h) => idsArg.includes(h.id)) : stranded;
  if (!targets.length) {
    console.log("\nnothing to drain.");
    return;
  }

  if (!KEY) throw new Error("--drain needs LP_PRIVATE_KEY (or PRIVATE_KEY) in the env");
  const signer = new ethers.Wallet(KEY, provider);

  if (pointer.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      `remove() is onlyGameRegistry and the pointer is ${pointer}, not ${signer.address}.\n` +
      `Point it here first:  vault.setGameRegistry("${signer.address}")\n` +
      `and restore it after: vault.setGameRegistry("${REGISTRY}")`
    );
  }

  console.log(`\ndraining ${targets.length} id(s) as ${signer.address}`);
  console.log(
    `!! while the pointer is on this EOA the live registry cannot register or\n` +
    `!! remove weight — and GameRegistry swallows the revert in a try/catch, so\n` +
    `!! settlement will look fine while silently dropping every new ticket's\n` +
    `!! weight. Restore the pointer as soon as this finishes.`
  );

  const withSigner = vault.connect(signer);
  for (const t of targets) {
    try {
      const tx = await withSigner.remove(t.id);
      await tx.wait();
      console.log(`  removed #${t.id} (${t.weight})  ${tx.hash}`);
    } catch (e) {
      // A null/BAD_DATA response is the RPC misbehaving, not a revert — remove()
      // is idempotent, so re-running the script is always safe.
      console.log(`  FAILED  #${t.id}: ${e.shortMessage || e.message}`);
    }
  }

  const after = await vault.totalWeight();
  console.log(`\ntotalWeight ${totalWeight} -> ${after} (${fmt(after)})`);
  console.log(`\nNOW RESTORE THE POINTER:  vault.setGameRegistry("${REGISTRY}")`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

// TimbSwap airdrop dispatcher — scheduled edge function (Supabase, Deno).
//
// The ONLY thing that touches the mainnet distributor key. On each (cron)
// invocation it: takes the single-sender lease, reopens crashed 'sending' rows,
// claims a batch of pending airdrop_outbox rows, and for each round sends real
// TIMB on Arbitrum One via TimbAirdropDistributor.distribute() — then resolves
// each row. Eligibility was already enforced on testnet by faucet-claim; here the
// contract's claimed[round][recipient] + caps are the on-chain backstop.
//
// One distribute() tx per round per run (bounded batch), so nonce handling is
// trivial and an edge-function time limit is never a risk. Cron re-fires to drain.
//
// Idempotency: before sending, rows already on-chain `isClaimed` are resolved
// 'sent' with no tx (recovers a prior run that paid but failed to resolve). A
// network error mid-send leaves rows 'sending' — expire_stale_airdrop_sending
// reopens them and the next run's isClaimed check resolves them correctly. Never
// a double-pay (the contract reverts a second claim regardless).
//
// Secrets (Supabase → Edge Functions):
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   (auto-injected)
//   AIRDROP_RPC_URL           Arbitrum One RPC
//   DISTRIBUTOR_ADDRESS       TimbAirdropDistributor on Arbitrum One
//   DISTRIBUTOR_PRIVATE_KEY   dispatcher hot wallet (set as the distributor's dispatcher)
//   AIRDROP_DISPATCH_SECRET   required header X-Dispatch-Secret to trigger a run
// Vars: AIRDROP_BATCH_LIMIT (default 50), AIRDROP_LEASE_SECONDS (default 120)
//
// Deploy: supabase functions deploy airdrop-dispatch  (keep verify_jwt ON, and/or
// require the header secret; this MOVES REAL VALUE — never leave it open).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ethers } from "https://esm.sh/ethers@6.13.4";

const SB_URL      = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RPC_URL     = Deno.env.get("AIRDROP_RPC_URL") ?? "";
const DIST_ADDR   = Deno.env.get("DISTRIBUTOR_ADDRESS") ?? "";
const DIST_KEY    = Deno.env.get("DISTRIBUTOR_PRIVATE_KEY") ?? "";
const RUN_SECRET  = Deno.env.get("AIRDROP_DISPATCH_SECRET") ?? "";
const BATCH_LIMIT = Number(Deno.env.get("AIRDROP_BATCH_LIMIT") ?? "50");
const LEASE_SECS  = Number(Deno.env.get("AIRDROP_LEASE_SECONDS") ?? "120");

const DIST_ABI = [
  "function distribute(address[] recipients, uint256 round) external",
  "function isClaimed(uint256 round, address recipient) external view returns (bool)",
];

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  // Fund-moving: never run open. Require the shared secret (and/or verify_jwt).
  if (RUN_SECRET && req.headers.get("X-Dispatch-Secret") !== RUN_SECRET) {
    return json({ ok: false, error: "forbidden" }, 401);
  }
  if (!RPC_URL || !DIST_ADDR || !DIST_KEY) {
    return json({ ok: false, error: "dispatcher not configured" }, 503);
  }

  const sb = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });

  // ── Single-sender lease ──
  const { data: gotLease, error: leaseErr } = await sb.rpc("airdrop_acquire_lease", { p_seconds: LEASE_SECS });
  if (leaseErr) return json({ ok: false, error: "lease error" }, 500);
  if (!gotLease) return json({ ok: true, skipped: "another run holds the lease" }, 200);

  const summary = { claimed: 0, sent: 0, recovered: 0, failed: 0, left_sending: 0 };
  try {
    // Reopen rows a prior crashed run stranded as 'sending' (idempotent, safe).
    await sb.rpc("expire_stale_airdrop_sending", { p_minutes: 10 });

    // Claim a batch atomically (pending → sending).
    const { data: rows, error: claimErr } = await sb.rpc("claim_airdrop_batch", { p_limit: BATCH_LIMIT });
    if (claimErr) throw new Error(`claim_airdrop_batch: ${claimErr.message}`);
    if (!rows || rows.length === 0) {
      return json({ ok: true, ...summary }, 200);
    }
    summary.claimed = rows.length;

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet   = new ethers.Wallet(DIST_KEY, provider);
    const dist     = new ethers.Contract(DIST_ADDR, DIST_ABI, wallet);

    // Group claimed rows by round.
    const byRound = new Map<number, any[]>();
    for (const r of rows) {
      const arr = byRound.get(r.round) ?? [];
      arr.push(r);
      byRound.set(r.round, arr);
    }

    let nonce = await provider.getTransactionCount(wallet.address, "pending");

    for (const [round, group] of byRound) {
      // Split into already-on-chain-claimed (recover as sent, no tx) vs to-send.
      const toSend: any[] = [];
      for (const row of group) {
        let already = false;
        try { already = await dist.isClaimed(round, row.address); } catch { already = false; }
        if (already) {
          await sb.rpc("resolve_airdrop", { p_id: row.id, p_status: "sent", p_tx: null });
          summary.recovered++;
        } else {
          toSend.push(row);
        }
      }
      if (toSend.length === 0) continue;

      const recipients = toSend.map((r) => ethers.getAddress(r.address));

      // Would-revert check (cap/dup) BEFORE spending a nonce/gas.
      let gasLimit: bigint;
      try {
        gasLimit = (await dist.distribute.estimateGas(recipients, round)) * 150n / 100n;
      } catch (e) {
        const msg = (e as any)?.shortMessage || (e as any)?.message || "distribute would revert";
        for (const row of toSend) {
          await sb.rpc("resolve_airdrop", { p_id: row.id, p_status: "failed", p_tx: null, p_error: msg });
          summary.failed++;
        }
        continue;
      }

      const fee = await provider.getFeeData();
      const overrides: any = { gasLimit, nonce };
      if (fee.maxFeePerGas)         overrides.maxFeePerGas         = fee.maxFeePerGas * 130n / 100n;
      if (fee.maxPriorityFeePerGas) overrides.maxPriorityFeePerGas = fee.maxPriorityFeePerGas * 130n / 100n;

      try {
        const tx = await dist.distribute(recipients, round, overrides);
        nonce++; // consumed
        const receipt = await tx.wait();
        const ok = receipt && receipt.status === 1;
        for (const row of toSend) {
          if (ok) { await sb.rpc("resolve_airdrop", { p_id: row.id, p_status: "sent", p_tx: tx.hash }); summary.sent++; }
          else    { await sb.rpc("resolve_airdrop", { p_id: row.id, p_status: "failed", p_tx: tx.hash, p_error: "tx reverted" }); summary.failed++; }
        }
      } catch (_e) {
        // Network/timeout after (maybe) broadcasting: DON'T mark failed. Leave the
        // rows 'sending' — expire_stale reopens them and next run's isClaimed check
        // resolves them correctly, so a mined-but-unconfirmed tx is never lost.
        summary.left_sending += toSend.length;
      }
    }

    return json({ ok: true, ...summary }, 200);
  } catch (e) {
    return json({ ok: false, error: (e as any)?.message || String(e), ...summary }, 500);
  } finally {
    await sb.rpc("airdrop_release_lease");
  }
});

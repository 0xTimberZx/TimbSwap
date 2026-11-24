// scripts/lib/tx.js — wait for a receipt, but never forever.
//
// Arbitrum is changing eth_sendRawTransaction to return as soon as a tx enters
// the sequencer's queue (notice: docs.arbitrum.io/notices/transaction-submission-
// changes-notice; testnets first, then Arbitrum One). A tx that passes the
// prechecks can still be dropped at block time (nonce gap, fee cap under the
// base fee, queue timeout). Today the send call returns that as an error; after
// the change it returns nothing, and the dropped tx never gets a receipt. A bare
// tx.wait() would then hang until the job's timeout (350 min for the settler,
// with the liveness revive seeing a settler "still running").
//
// waitMined(tx) waits up to timeoutMs. On timeout it checks the receipt once
// more; if there is still none it throws code "TX_DROPPED", so the caller fails
// the way it already does on a send error (alert, exit, retry with a fresh
// nonce and fee). A mined receipt is returned; a reverted one throws, as
// ethers' own tx.wait() does.

const DEFAULT_TIMEOUT_MS = 120_000;

async function waitMined(tx, { timeoutMs = DEFAULT_TIMEOUT_MS, provider } = {}) {
  try {
    return await tx.wait(1, timeoutMs);
  } catch (e) {
    if (e?.code !== "TIMEOUT") throw e;
    const prov = provider || tx.provider;
    let r = null;
    try { r = prov ? await prov.getTransactionReceipt(tx.hash) : null; } catch { /* treat as no receipt */ }
    if (r && r.blockNumber != null) {
      if (r.status === 0) {
        throw Object.assign(new Error(`transaction reverted (${tx.hash})`), { code: "CALL_EXCEPTION", receipt: r });
      }
      return r;
    }
    throw Object.assign(
      new Error(`no receipt for ${tx.hash} after ${Math.round(timeoutMs / 1000)}s: dropped or stuck in the queue`),
      { code: "TX_DROPPED", transaction: tx }
    );
  }
}

module.exports = { waitMined, DEFAULT_TIMEOUT_MS };

// ── Self-test: node lib/tx.js --self-test (stubbed txs; no network) ──
if (require.main === module && process.argv.includes("--self-test")) {
  (async () => {
    let pass = 0, fail = 0;
    const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error("FAIL:", name); } };
    const timeoutErr = () => Object.assign(new Error("timeout"), { code: "TIMEOUT" });
    const mk = ({ wait, receipt, receiptThrows }) => ({
      hash: "0xabc",
      wait: async (c, t) => wait(c, t),
      provider: { getTransactionReceipt: async () => { if (receiptThrows) throw new Error("rpc"); return receipt; } },
    });
    const caught = async (p) => { try { await p; return null; } catch (e) { return e; } };

    // 1. Mined in time: receipt passes straight through, with the timeout forwarded.
    let seen;
    const r1 = await waitMined(mk({ wait: (c, t) => { seen = [c, t]; return { status: 1, blockNumber: 5 }; } }), { timeoutMs: 9000 });
    ok("mined: returns receipt", r1.status === 1);
    ok("mined: passes 1 confirmation and the timeout to tx.wait", seen[0] === 1 && seen[1] === 9000);

    // 2. Revert: ethers' CALL_EXCEPTION is rethrown untouched.
    const e2 = await caught(waitMined(mk({ wait: () => { throw Object.assign(new Error("reverted"), { code: "CALL_EXCEPTION" }); } })));
    ok("revert: rethrows CALL_EXCEPTION", e2 && e2.code === "CALL_EXCEPTION");

    // 3. Timeout, then no receipt: TX_DROPPED.
    const e3 = await caught(waitMined(mk({ wait: () => { throw timeoutErr(); }, receipt: null }), { timeoutMs: 1000 }));
    ok("dropped: throws TX_DROPPED", e3 && e3.code === "TX_DROPPED");
    ok("dropped: message names the hash", e3 && e3.message.includes("0xabc"));

    // 4. Timeout, but the receipt landed meanwhile: return it.
    const r4 = await waitMined(mk({ wait: () => { throw timeoutErr(); }, receipt: { status: 1, blockNumber: 7 } }));
    ok("late receipt: returned", r4 && r4.blockNumber === 7);

    // 5. Timeout, late receipt is a revert: CALL_EXCEPTION with the receipt.
    const e5 = await caught(waitMined(mk({ wait: () => { throw timeoutErr(); }, receipt: { status: 0, blockNumber: 7 } })));
    ok("late revert: CALL_EXCEPTION with receipt", e5 && e5.code === "CALL_EXCEPTION" && e5.receipt.status === 0);

    // 6. Timeout and the receipt read itself fails: still TX_DROPPED, never a hang.
    const e6 = await caught(waitMined(mk({ wait: () => { throw timeoutErr(); }, receiptThrows: true })));
    ok("receipt read fails: TX_DROPPED", e6 && e6.code === "TX_DROPPED");

    // 7. Other wait errors (network) pass through unchanged.
    const e7 = await caught(waitMined(mk({ wait: () => { throw Object.assign(new Error("net"), { code: "NETWORK_ERROR" }); } })));
    ok("network error: passes through", e7 && e7.code === "NETWORK_ERROR");

    // 8. Default timeout is used when none is given.
    let t8;
    await waitMined(mk({ wait: (c, t) => { t8 = t; return { status: 1, blockNumber: 1 }; } }));
    ok("default timeout applied", t8 === DEFAULT_TIMEOUT_MS);

    console.log(fail ? `tx self-test: ${fail} failed` : `tx self-test: ${pass} passed, 0 failed`);
    process.exit(fail ? 1 : 0);
  })();
}

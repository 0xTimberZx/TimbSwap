// lib/logs.js — chunked event scans.
//
// Public RPCs serve wide eth_getLogs ranges but not unbounded ones, and metered
// ones cap the range hard. Every scan here walks the range in fixed chunks so a
// backfill of millions of blocks is a loop of bounded calls rather than one
// request that a provider may refuse.

const { ethers } = require("ethers");

const DEFAULT_CHUNK = 40_000;

/**
 * Raw logs for `address`/`topics` over [fromBlock, toBlock], in chain order.
 * `onChunk(from, to, count)` is called after each chunk for progress output.
 */
async function scanLogs(provider, { address, topics, fromBlock, toBlock, chunk = DEFAULT_CHUNK, onChunk }) {
  const out = [];
  for (let from = fromBlock; from <= toBlock; from += chunk) {
    const to = Math.min(from + chunk - 1, toBlock);
    let logs;
    try {
      logs = await provider.getLogs({ address, topics, fromBlock: from, toBlock: to });
    } catch (e) {
      // ethers hides the provider's own message behind "could not coalesce
      // error"; surface it so a range cap or an unsupported method reads as
      // what it is in the run log.
      const inner = e?.error?.message || e?.info?.error?.message || e?.info?.responseBody;
      throw new Error(`getLogs ${from}-${to}: ${e.shortMessage || e.message}${inner ? " — " + String(inner).slice(0, 300) : ""}`);
    }
    out.push(...logs);
    if (onChunk) onChunk(from, to, logs.length);
  }
  out.sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index);
  return out;
}

/**
 * Decoded events of one name from one contract: [{ args, log }].
 * `iface` is an ethers.Interface that knows the event.
 */
async function scanEvents(provider, iface, eventName, address, fromBlock, toBlock, opts = {}) {
  const topic = iface.getEvent(eventName).topicHash;
  const logs = await scanLogs(provider, { address, topics: [topic], fromBlock, toBlock, ...opts });
  return logs.map((log) => ({ args: iface.parseLog(log).args, log }));
}

/** Sum `pick(args)` (a bigint) over the events of one name. */
async function sumEvents(provider, iface, eventName, address, fromBlock, toBlock, pick, opts = {}) {
  let total = 0n;
  for (const { args } of await scanEvents(provider, iface, eventName, address, fromBlock, toBlock, opts)) {
    total += pick(args);
  }
  return total;
}

/**
 * Timestamps for a set of block numbers: { [block]: unixSeconds }. One getBlock
 * per DISTINCT block, `batch` at a time, so a burst of events in one block costs
 * one call.
 */
async function blockTimestamps(provider, blocks, batch = 10) {
  const distinct = [...new Set(blocks)];
  const tsOf = {};
  for (let i = 0; i < distinct.length; i += batch) {
    const slice = distinct.slice(i, i + batch);
    const got = await Promise.all(slice.map((b) => provider.getBlock(b)));
    got.forEach((blk, k) => { tsOf[slice[k]] = blk.timestamp; });
  }
  return tsOf;
}

module.exports = { DEFAULT_CHUNK, scanLogs, scanEvents, sumEvents, blockTimestamps, ethers };

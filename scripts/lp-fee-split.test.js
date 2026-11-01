const test = require("node:test");
const assert = require("node:assert");
const { wethFromFeeLp, redact } = require("./lp-fee-split");

test("no fee LP above the treasury's own liquidity -> nothing", () => {
  assert.deepStrictEqual(wethFromFeeLp({ lpBalance: 100n, polLp: 100n, totalSupply: 1000n, wethReserve: 50n }), { feeLp: 0n, weth: 0n });
  assert.deepStrictEqual(wethFromFeeLp({ lpBalance: 50n, polLp: 100n, totalSupply: 1000n, wethReserve: 50n }), { feeLp: 0n, weth: 0n });
});

test("fee LP redeems pro rata against the WETH reserve", () => {
  assert.deepStrictEqual(wethFromFeeLp({ lpBalance: 150n, polLp: 100n, totalSupply: 1000n, wethReserve: 400n }), { feeLp: 50n, weth: 20n });
});

test("empty pool -> nothing", () => {
  assert.deepStrictEqual(wethFromFeeLp({ lpBalance: 10n, polLp: 0n, totalSupply: 0n, wethReserve: 0n }), { feeLp: 10n, weth: 0n });
});

test("redact scrubs the RPC URL from error text", () => {
  const url = "https://arb-mainnet.example/v2/SECRETKEY";
  const r = redact(`could not detect network (${url})`, url);
  assert.ok(!r.includes("SECRETKEY") && r.includes("<LP_SPLIT_RPC>"));
  assert.strictEqual(redact("plain", ""), "plain");
});

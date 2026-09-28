// node --test scripts/top-trader.test.js
const test = require("node:test");
const assert = require("node:assert");
const { rankTraders } = require("./top-trader");

const WETH = "0x00000000000000000000000000000000000000e7";
const USDC = "0x00000000000000000000000000000000000000c0";
const A = "0x000000000000000000000000000000000000000a";
const B = "0x000000000000000000000000000000000000000b";
const s = (sender, tokenIn, tokenOut, amountIn, amountOut, blockNumber, index = 0) =>
  ({ sender, tokenIn, tokenOut, amountIn, amountOut, blockNumber, index });

test("counts only the ETH side of each swap", () => {
  const r = rankTraders([
    s(A, WETH, USDC, 5n, 999n, 1),   // ETH in: 5
    s(A, USDC, WETH, 999n, 3n, 2),   // ETH out: 3
    s(B, USDC, USDC, 1000n, 1000n, 3) // no ETH leg: ignored
  ], WETH);
  assert.equal(r.length, 1);
  assert.equal(r[0].wallet, A);
  assert.equal(r[0].volume, 8n);
});

test("ranks by volume, ties to whoever reached the total first", () => {
  const r = rankTraders([
    s(A, WETH, USDC, 4n, 1n, 10),
    s(B, WETH, USDC, 4n, 1n, 11),
    s(A, WETH, USDC, 1n, 1n, 20),
    s(B, WETH, USDC, 1n, 1n, 12), // B reaches 5 at block 12, A at block 20
  ], WETH);
  assert.deepEqual(r.map(x => x.wallet), [B, A]);
});

test("address matching is case-insensitive", () => {
  const r = rankTraders([s(A, WETH.toUpperCase().replace("0X", "0x"), USDC, 7n, 1n, 1)], WETH);
  assert.equal(r[0].volume, 7n);
});

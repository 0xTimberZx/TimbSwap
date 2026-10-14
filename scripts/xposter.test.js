// node --test scripts/xposter.test.js
const test = require("node:test");
const assert = require("node:assert");
const { isDecliningRollover } = require("./xposter");

const r = (winners, entries, prevEntries) => ({ round: 42, string6: "ABCDEF", potEth: "0.25", winners, entries, prevEntries });

test("a no-winner round with fewer entries than the last is a declining rollover", () => {
  assert.equal(isDecliningRollover(r(0, 12, 15)), true);
});

test("level or rising entries are not a decline", () => {
  assert.equal(isDecliningRollover(r(0, 15, 15)), false);
  assert.equal(isDecliningRollover(r(0, 18, 15)), false);
});

test("a round that paid out is not a rollover", () => {
  assert.equal(isDecliningRollover(r(1, 12, 15)), false);
});

test("an unknown previous count never counts as a decline", () => {
  assert.equal(isDecliningRollover(r(0, 12, null)), false);
  assert.equal(isDecliningRollover(r(0, 12, undefined)), false);
});

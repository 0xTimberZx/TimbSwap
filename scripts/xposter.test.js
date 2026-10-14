// node --test scripts/xposter.test.js
const test = require("node:test");
const assert = require("node:assert");
const { shouldPost, roundText } = require("./xposter");

const base = { round: 42, string6: "AB0CDE", potEth: "0.25", carryEth: "0.25" };
const rolled   = { ...base, winners: 0, entries: 12, prevEntries: 15 };   // no winner, entries down
const flat     = { ...base, winners: 0, entries: 15, prevEntries: 15 };   // no winner, entries level
const rising   = { ...base, winners: 0, entries: 18, prevEntries: 15 };   // no winner, entries up
const unknown  = { ...base, winners: 0, entries: 12, prevEntries: null }; // previous count unreadable
const won      = { ...base, winners: 1, entries: 12, prevEntries: 15, carryEth: null };

test("rollover-declining posts only a no-winner round with fewer entries than the last", () => {
  const m = "rollover-declining";
  assert.equal(shouldPost(m, rolled), true);
  assert.equal(shouldPost(m, flat), false, "level entries are not a decline");
  assert.equal(shouldPost(m, rising), false);
  assert.equal(shouldPost(m, unknown), false, "an unknown comparison never counts as a decline");
  assert.equal(shouldPost(m, won), false, "a round that paid out is not a rollover");
});

test("the other modes keep their meaning, and an unknown mode posts nothing", () => {
  assert.equal(shouldPost("all", rising), true);
  assert.equal(shouldPost("all", won), true);
  assert.equal(shouldPost("winners", won), true);
  assert.equal(shouldPost("winners", rolled), false);
  assert.equal(shouldPost("off", won), false);
  assert.equal(shouldPost("everything", won), false);
});

test("a declining rollover post states the carry and the drop", () => {
  const t = roundText(rolled);
  assert.match(t, /no winner\. 0\.25 ETH rolls into Round #43\./);
  assert.match(t, /12 entries this round, down from 15\./);
  assert.match(t, /AB0̸CDE/, "zeros are slashed so they can't read as O");
  assert.match(t, /timbswap\.xyz\/compete/);
  assert.match(roundText({ ...rolled, entries: 1 }), /1 entry this round/);
});

test("winner and plain rollover posts keep their own wording", () => {
  assert.match(roundText(won), /🏆 Round #42 SETTLED/);
  assert.doesNotMatch(roundText(rising), /down from/);
  assert.match(roundText(rising), /0\.25 ETH rolls into Round #43/);
});

test("every post stays inside X's 280-character limit", () => {
  for (const r of [rolled, rising, won, { ...rolled, entries: 9999, prevEntries: 10000, carryEth: "1234.5678" }]) {
    assert.ok([...roundText(r)].length <= 280, `too long: ${roundText(r).length}`);
  }
});

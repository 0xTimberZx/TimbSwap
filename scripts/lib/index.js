// scripts/lib — the keeper plumbing every job in the fleet shares.
//
//   config.js    read addresses and the public RPC out of config.js
//   logs.js      chunked eth_getLogs scans and block timestamps
//   state.js     a job's own cursor file, keyed to its deployment
//   telegram.js  best-effort ops alerts with the ops-mode switch and a re-alert throttle
//
// Design rules (dev-docs/KEEPER_FLEET.md): writers act, witnesses only alert,
// every job owns its own state, and the only shared input is config.js.

module.exports = {
  ...require("./config"),
  ...require("./logs"),
  ...require("./state"),
  ...require("./telegram"),
};

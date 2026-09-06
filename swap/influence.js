// influence.js — React micro-component for prize influence indicators.
// Mounts 3 small cards: scroll position, segment status, pot size.
// Renders only when an eligible pair is selected on the swap page.

const { useState, useEffect, useRef } = React;

const TIMBPRIZE_MINI_ABI = [
  "function getRoundState() external view returns (uint256 round, uint256 segment, uint256 segmentStart, uint256 counter, bytes6 currentWindow, uint256 pot, uint256 unclaimedPool, bool inSettlement)",
  "function gameStarted() external view returns (bool)"
];
// The router decides how many meter units an eligible swap is worth (owner-set,
// 1..10). Read it live so the label never drifts from the contract.
const ROUTER_MINI_ABI = ["function swapNudgeWeight() external view returns (uint256)"];

function PrizeIndicators() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(false);
  const pollRef = useRef(null);

  async function fetchState() {
    try {
      const readProv = sharedReadProvider();
      const prize  = new ethers.Contract(ADDRESSES.TimbPrize, TIMBPRIZE_MINI_ABI, readProv);
      const router = new ethers.Contract(ADDRESSES.TimbSwapRouter, ROUTER_MINI_ABI, readProv);

      const started = await prize.gameStarted();
      if (!started) { setState({ started: false }); return; }

      const s = await prize.getRoundState();
      // Live nudge weight; fall back to 3 (current on-chain value) if the read
      // hiccups, so the label never shows "+undefined".
      let nudge = 3;
      try { nudge = (await router.swapNudgeWeight()).toNumber(); } catch {}
      setState({
        started: true,
        round: s.round.toString(),
        segment: s.segment.toString(),
        counter: s.counter.toString(),
        pot: s.pot,
        nudge,
        inSettlement: s.inSettlement,
        segmentStart: s.segmentStart.toNumber()
      });
      setError(false);
    } catch (e) {
      console.warn("PrizeIndicators fetch failed:", e.message);
      setError(true);
    }
  }

  useEffect(() => {
    fetchState();
    // Only poll while the tab is visible so a backgrounded swap tab doesn't
    // drain the shared public-RPC quota (which throttles the IP and stalls
    // reads across every page). Re-poll on focus so it's fresh on return.
    pollRef.current = setInterval(() => { if (!document.hidden) fetchState(); }, 6000);
    const onVis = () => { if (!document.hidden) fetchState(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(pollRef.current); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  if (error) {
    return React.createElement("div", { className: "pi-card pi-error" },
      "Prize data unavailable"
    );
  }

  if (!state) {
    return React.createElement("div", { className: "pi-card pi-loading" }, "Loading…");
  }

  if (!state.started) {
    return React.createElement("div", { className: "pi-card pi-loading" }, "Game not started");
  }

  const elapsed = Math.floor(Date.now() / 1000) - state.segmentStart;
  const remaining = Math.max(0, (59 * 60 + 45) - elapsed);
  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");

  return React.createElement("div", { className: "pi-stack" },

    // Card 1 — Scroll position
    React.createElement("div", { className: "pi-card" },
      React.createElement("div", { className: "pi-label" }, "SCROLL POSITION"),
      React.createElement("div", { className: "pi-value pi-mono" }, "#" + state.counter),
      React.createElement("div", { className: "pi-sub" }, `Nudges +${state.nudge} per eligible swap`)
    ),

    // Card 2 — Segment status
    React.createElement("div", { className: "pi-card" },
      React.createElement("div", { className: "pi-label" }, "SEGMENT STATUS"),
      React.createElement("div", { className: "pi-value pi-mono" },
        state.inSettlement
          ? React.createElement("span", { className: "pi-settling" }, "SETTLING")
          : `${mm}:${ss}`
      ),
      React.createElement("div", { className: "pi-sub" },
        `Round ${state.round} · Segment ${state.segment}/6`)
    ),

    // Card 3 — Pot size
    React.createElement("div", { className: "pi-card pi-pot" },
      React.createElement("div", { className: "pi-label" }, "PRIZE POT"),
      React.createElement("div", { className: "pi-value pi-mono pi-green" },
        fmt(state.pot) + " ETH"),
      React.createElement("div", { className: "pi-sub" }, "Builds from eligible swaps")
    )
  );
}

let reactRoot = null;

window.renderPrizeIndicators = function(visible) {
  const mount = document.getElementById("prize-indicators-root");
  if (!mount) return;

  if (!visible) {
    if (reactRoot) { reactRoot.unmount(); reactRoot = null; }
    return;
  }

  if (!reactRoot) {
    reactRoot = ReactDOM.createRoot(mount);
  }
  reactRoot.render(React.createElement(PrizeIndicators));
};

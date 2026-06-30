// influence.js — React micro-component for prize influence indicators.
// Mounts 3 small cards: scroll position, segment status, pot size.
// Renders only when an eligible pair is selected on the swap page.

const { useState, useEffect, useRef } = React;

const TIMBPRIZE_MINI_ABI = [
  "function getRoundState() external view returns (uint256 round, uint256 segment, uint256 segmentStart, uint256 counter, bytes6 currentWindow, uint256 pot, uint256 unclaimedPool, bool inSettlement)",
  "function gameStarted() external view returns (bool)"
];

function PrizeIndicators() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(false);
  const pollRef = useRef(null);

  async function fetchState() {
    try {
      const readProv = (typeof provider !== "undefined" && provider)
        ? provider
        : new ethers.providers.JsonRpcProvider(RPC_URL);
      const prize = new ethers.Contract(ADDRESSES.TimbPrize, TIMBPRIZE_MINI_ABI, readProv);

      const started = await prize.gameStarted();
      if (!started) { setState({ started: false }); return; }

      const s = await prize.getRoundState();
      setState({
        started: true,
        round: s.round.toString(),
        segment: s.segment.toString(),
        counter: s.counter.toString(),
        pot: s.pot,
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
    pollRef.current = setInterval(fetchState, 4000);
    return () => clearInterval(pollRef.current);
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
      React.createElement("div", { className: "pi-sub" }, "Nudges +1 per eligible swap")
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

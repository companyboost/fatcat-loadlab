// Counters, so a run can prove where the backend's Hyperliquid traffic went.
//
// The decisive check in any simulated run is not "did the simulator get
// requests" — it is "did the simulator get them AND production's real HL
// traffic stay flat". A difference has no direction on its own, so the
// simulator counts its own side and the runbook compares both.

const counters = new Map();
const startedAt = Date.now();

export function inc(key, by = 1) {
  counters.set(key, (counters.get(key) ?? 0) + by);
}

export function snapshot() {
  const uptimeSec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
  const out = { uptimeSec, counters: {}, rates: {} };
  for (const [k, v] of counters) {
    out.counters[k] = v;
    // Derive rates here rather than leaving it to the reader: a rolling window
    // read as a spot value is how the last measurement round produced numbers
    // that oscillated and looked like noise.
    out.rates[k] = Number((v / uptimeSec).toFixed(4));
  }
  return out;
}

export { counters };

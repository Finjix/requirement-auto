/** A clock the tests move by hand: sleeping just advances it, so nothing waits for real. */
export function clock(start = 1_700_000_000_000) {
  const state = { t: start, slept: [] as number[] };
  return { state, now: () => state.t, sleep: async (ms: number) => { state.slept.push(ms); state.t += ms; } };
}

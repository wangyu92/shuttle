// Simulator CLI (design §7.4, ops-spec §3.4). Bundled and started by packages/sim/bin/sim.mjs:
//   npm run sim -w @shuttle/sim -- --seeds 200 --devices 3 --steps 300
//   npm run sim -w @shuttle/sim -- --seed 123 --devices 3 --steps 500 --trace-dir <dir>
//   npm run sim -w @shuttle/sim -- --seed 123 --devices 3 --steps 500 --shrink
// Options: --seeds N (seeds first..first+N-1), --first S (default 1), --seed S (one seed),
// --devices N or A..B (cycled over seeds), --steps N, --check-every N, --no-faults, --trace-dir DIR
// (failing seeds write <dir>/<seed>.jsonl), --shrink, --json (one JSON line per seed), --no-excluded
// (no device excludes a folder), --no-edit-while-down (user acts only on running devices),
// --settle-restart (restarts finish catch-up before the next action), --ci (the vitest configuration), --weight action=N (repeatable; 0 disables an action).
// Exit code 1 when any seed fails.

import { mkdirSync, writeFileSync } from "node:fs";
import { ACTIONS, replayCommand, runSim, shrinkSteps, type SimOptions, type SimResult } from "./sim";

interface Args {
  first: number; seeds: number; devices: [number, number]; steps: number; checkEvery: number; faults: boolean;
  traceDir: string | null; shrink: boolean; json: boolean; excluded: boolean; editWhileDown: boolean; settleRestart: boolean; ci: boolean; weights: Record<string, number>;
}

function parse(argv: string[]): Args {
  const a: Args = { first: 1, seeds: 1, devices: [3, 3], steps: 300, checkEvery: 100, faults: true, traceDir: null, shrink: false, json: false, excluded: true, editWhileDown: true, settleRestart: false, ci: false, weights: {} };
  const num = (v: string | undefined, name: string): number => {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} needs a non-negative integer, got ${v}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = argv[i + 1];
    switch (k) {
      case "--seeds": a.seeds = num(v, k); i++; break;
      case "--first": a.first = num(v, k); i++; break;
      case "--seed": a.first = num(v, k); a.seeds = 1; i++; break;
      case "--devices": {
        const m = /^(\d+)(?:\.\.(\d+))?$/.exec(v ?? "");
        if (!m) throw new Error(`--devices needs N or A..B, got ${v}`);
        const lo = Number(m[1]), hi = Number(m[2] ?? m[1]);
        if (lo < 1 || hi < lo) throw new Error(`bad --devices ${v}`);
        a.devices = [lo, hi]; i++; break;
      }
      case "--steps": a.steps = num(v, k); i++; break;
      case "--check-every": a.checkEvery = num(v, k); i++; break;
      case "--no-faults": a.faults = false; break;
      case "--trace-dir": a.traceDir = v ?? null; i++; break;
      case "--shrink": a.shrink = true; break;
      case "--json": a.json = true; break;
      case "--no-excluded": a.excluded = false; break;
      case "--no-edit-while-down": a.editWhileDown = false; break;
      case "--settle-restart": a.settleRestart = true; break;
      // The configuration of the vitest set: no user edits on dead devices, restarts settle, no
      // excluded folders (the open engine findings are covered by scripted tests).
      case "--ci": a.editWhileDown = false; a.settleRestart = true; a.excluded = false; break;
      case "--weight": {
        // --weight action=N (repeatable): override one action weight, 0 disables it.
        const m = /^([A-Za-z]+)=(\d+(?:\.\d+)?)$/.exec(v ?? "");
        if (!m || !(ACTIONS as readonly string[]).includes(m[1]!)) throw new Error(`--weight needs action=N with one of ${ACTIONS.join(", ")}; got ${v}`);
        a.weights[m[1]!] = Number(m[2]);
        i++; break;
      }
      case "--replay": break; // accepted for the design's replay command; a seed always replays.
      default: throw new Error(`unknown option ${k}`);
    }
  }
  return a;
}

function line(r: SimResult): string {
  const s = r.stats;
  return `seed ${r.seed} d${r.devices} s${r.steps} ${r.ok ? "ok  " : "FAIL"} ${r.ms} ms  commits ${s.commits} crashes ${s.crashes} ` +
    `faults ${s.netFaults} copies ${s.conflictCopies} rebuilds ${s.rebuilds} compactions ${s.compactions} ledger ${s.ledgerEntries} hash ${r.traceHash.slice(0, 12)}`;
}

async function main(): Promise<number> {
  const a = parse(process.argv.slice(2));
  const t0 = Date.now();
  let failed = 0;
  const times: number[] = [];
  for (let k = 0; k < a.seeds; k++) {
    const seed = a.first + k;
    const span = a.devices[1] - a.devices[0] + 1;
    const devices = a.devices[0] + (k % span);
    const o: SimOptions = {
      seed, devices, steps: a.steps, checkEvery: a.checkEvery, faults: a.faults, keepTrace: a.traceDir !== null,
      excludedFolders: a.excluded, editWhileDown: a.editWhileDown, settleRestart: a.settleRestart, weights: a.weights as NonNullable<SimOptions["weights"]>,
    };
    let r = await runSim(o);
    times.push(r.ms);
    if (a.json) process.stdout.write(JSON.stringify({ ...r, trace: undefined }) + "\n");
    else process.stdout.write(line(r) + "\n");
    if (r.ok) continue;
    failed++;
    for (const f of r.failures.slice(0, 10)) process.stdout.write(`  ${f.inv} @ step ${f.step}: ${f.detail}\n`);
    if (a.shrink) {
      r = await shrinkSteps(o, r);
      process.stdout.write(`  shrunk to ${r.steps} steps: ${r.failures[0]?.inv} @ ${r.failures[0]?.step}\n`);
    }
    const flags = (a.checkEvery !== 100 ? ` --check-every ${a.checkEvery}` : "") + (a.faults ? "" : " --no-faults") +
      (a.excluded ? "" : " --no-excluded") + (a.editWhileDown ? "" : " --no-edit-while-down") + (a.settleRestart ? " --settle-restart" : "") + Object.entries(a.weights).map(([k, n]) => ` --weight ${k}=${n}`).join("");
    process.stdout.write(`  replay: ${replayCommand(r, flags)}\n`);
    if (a.traceDir) {
      mkdirSync(a.traceDir, { recursive: true });
      const again = await runSim({ ...o, steps: r.steps, keepTrace: true });
      const out = [...(again.trace ?? []), ...again.failures.map((f) => JSON.stringify({ failure: f }))].join("\n") + "\n";
      writeFileSync(`${a.traceDir}/${seed}.jsonl`, out);
      process.stdout.write(`  trace: ${a.traceDir}/${seed}.jsonl\n`);
    }
  }
  const total = Date.now() - t0;
  times.sort((x, y) => x - y);
  const mean = times.reduce((x, y) => x + y, 0) / Math.max(1, times.length);
  const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] ?? 0;
  process.stdout.write(`${a.seeds - failed}/${a.seeds} seeds passed in ${(total / 1000).toFixed(1)} s; per seed mean ${mean.toFixed(0)} ms, p95 ${p95} ms, max ${times[times.length - 1] ?? 0} ms\n`);
  return failed ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (e: unknown) => {
  process.stderr.write(`sim: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 2;
});

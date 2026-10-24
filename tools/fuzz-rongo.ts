// Headless fuzzer for the Rongo Rongo state machine (src/games/paaseiland/rongo-logic.ts).
// Simulates the 100 ms AniTimer, sound durations and random player input, with the
// original's range checks in strict mode, to find the sequences that crashed the 1996 game.
// Run: node tools/fuzz-rongo.ts [runs]
import { RongoLogic, RangeCheckError, St } from '../src/games/paaseiland/rongo-logic.ts';

// durations (ms) of GE0701..GE0722
const DUR = [20638, 5661, 682, 356, 597, 453, 500, 500, 500, 500, 500, 500, 975, 453, 400, 400, 400, 400, 400, 400, 975, 437];

// distance-to-solved table for greedy solving
const dist = new Map<string, number>();
{
  const start = '012345678';
  dist.set(start, 0);
  const q = [start];
  for (let h = 0; h < q.length; h++) {
    const s = q[h], e = s.indexOf('8'), d = dist.get(s)!;
    for (const n of [e - 3, e + 3, e % 3 ? e - 1 : -1, e % 3 < 2 ? e + 1 : -1]) {
      if (n < 0 || n > 8) continue;
      const a = s.split('');
      [a[e], a[n]] = [a[n], a[e]];
      const t = a.join('');
      if (!dist.has(t)) { dist.set(t, d + 1); q.push(t); }
    }
  }
}

let seed = 12345;
const rand = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return Math.floor((seed / 2 ** 32) * n); };

function run(maxSteps: number, log: string[]): string | null {
  let now = 0, soundEnd = 0, interval = 100, nextTick = 100, closed = false;
  const g: RongoLogic = new RongoLogic({
    playSound(i, flags) {
      if (flags & 0x10 && now < soundEnd) return false;
      soundEnd = i === null ? now : now + DUR[i];
      return true;
    },
    playQuestion() { soundEnd = now + 1500; },
    random: rand,
    mouth() {},
    repaint() {},
    setTimerInterval(ms) { interval = ms; },
    close() { closed = true; g.onClose(); },
  }, true);
  try {
    g.start();
    for (let step = 0; step < maxSteps && !closed; step++) {
      const r = rand(100);
      if (r < 55) {
        now = nextTick; nextTick += interval; g.tick();
      } else if (r < 85) {
        // move: mostly greedy towards the solution, sometimes random
        let cell = rand(9);
        if (rand(3) > 0) {
          const e = g.empty, cand = [e - 3, e + 3, e % 3 ? e - 1 : -1, e % 3 < 2 ? e + 1 : -1].filter((n) => n >= 0 && n <= 8);
          let best = cand[0], bd = 1e9;
          for (const n of cand) {
            const a = [...g.board]; [a[e], a[n]] = [a[n], a[e]];
            const d = dist.get(a.join(''))!;
            if (d < bd) { bd = d; best = n; }
          }
          cell = best;
        }
        log.push(`t=${now} click cell ${cell}`);
        g.selectCell(cell % 3, Math.floor(cell / 3));
      } else if (r < 93) {
        log.push(`t=${now} click Rongo`); g.mouseDown(480, 100);
      } else if (r < 96) {
        log.push(`t=${now} stop icon`); g.requestQuit();
      } else {
        const yes = rand(4) === 0;
        log.push(`t=${now} click ${yes ? 'JA' : 'NEE'}`);
        g.mouseDown(yes ? 480 : 550, 180);
      }
      if (log.length > 60) log.shift();
    }
  } catch (e) {
    if (e instanceof RangeCheckError) return `${e.message} | state=${g.state} speakIdx=${g.speakIdx} speaking=${g.speaking} playing=${g.playing} empty=${g.empty}`;
    throw e;
  }
  void St;
  return null;
}

const runs = Number(process.argv[2] ?? 2000);
let crashes = 0;
const kinds = new Map<string, string[]>();
for (let i = 0; i < runs; i++) {
  const log: string[] = [];
  const res = run(3000, log);
  if (res) {
    crashes++;
    const k = res.split(' | ')[0].replace(/: .*/, '');
    if (!kinds.has(k)) kinds.set(k, [res, ...log.slice(-15)]);
  }
}
console.log(`${crashes}/${runs} runs hit a range check error`);
for (const [k, v] of kinds) console.log(`\n== ${k}\n${v.join('\n')}`);

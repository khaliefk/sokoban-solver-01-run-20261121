// Sokoban solver: push-optimal A* per room.
//
// A level is a hallway with one to four rooms off it, each room holding 3 or 4
// boxes and as many goals, and a box never leaves its room. So the level splits
// into independent rooms: each room is solved on its own, push-optimally, and
// the moves are stitched together with walks along the hallway. The push count
// of the whole level is then the sum of the rooms' optima.
//
// Each room is searched over pushes, not steps: a state is the boxes' squares
// plus the player's reachable region (named by its lowest square). A* orders
// states by pushes made plus a minimum-cost assignment of boxes to goals, where
// the cost of one box to one goal is the walking distance between them around
// the walls. One push moves one box one square, so that assignment cost can
// drop by at most one per push, which makes it admissible and consistent, and
// the first solved state A* pops is push-optimal.
//
// Two deadlocks are pruned and never remove a solvable state: a box pushed
// onto a square from which no pull brings it to a goal (a dead square), and a
// box pushed into a frozen 2x2 block of walls and boxes holding a box off its
// goal. The search is bounded by work (states expanded), never by the clock,
// so two runs write the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budget for the whole set, in state expansions: deterministic, never the clock.
const TOTAL_EXPANSION_BUDGET = 6_000_000;
// Work budget for one room's search.
const ROOM_EXPANSION_BUDGET = 1_500_000;

const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

let expansionsLeft = TOTAL_EXPANSION_BUDGET;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** Squares from which a box can be pulled back onto some goal, ignoring the other boxes. */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Walking distances from one goal over open floor (walls only, no boxes). */
function distancesFrom(wall: Uint8Array, w: number, from: number): Int32Array {
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [from];
  dist[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    const base = dist[p]!;
    for (const [dx, dy] of DIRS) {
      const q = p + dy * w + dx;
      if (!wall[q] && dist[q] < 0) {
        dist[q] = base + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a
 * box there reaches no goal) out of the floor, and each part left that holds a
 * box is a room. Null when the level is no set of rooms.
 */
function roomsOf(level: Level): { squares: number[]; boxes: number[]; goals: number[] }[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { squares: number[]; boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i]!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]]!.boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The lowest square the player reaches from `from`, with `occupied` in the way. */
function regionLow(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (!wall[q] && !occupied[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block with a box off its goal. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/**
 * The push-optimal moves for one level (or a room cut out of one), A* over
 * pushes. Returns null when the search gives up (budget spent) or the level
 * has no solution.
 */
function solvePushOptimal(level: Level, maxExpansions: number): string | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const n = goals.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;
  if (solved(level.boxes)) return '';

  // Distance from every square to every goal, for the assignment heuristic.
  const distToGoal: Int32Array[] = goals.map((g) => distancesFrom(wall, w, g));
  // The cheapest assignment of boxes to goals, by trying every pairing (n <= 4
  // in a room; a whole level falls back to the sum of nearest goals).
  const heuristic = (boxes: number[]): number => {
    if (n <= 4) {
      let best = Infinity;
      const perm = goals.map((_, i) => i);
      const tryPerm = (k: number, sum: number): void => {
        if (sum >= best) return;
        if (k === n) {
          best = sum;
          return;
        }
        for (let i = k; i < n; i++) {
          [perm[k], perm[i]] = [perm[i]!, perm[k]!];
          const d = distToGoal[perm[k]!]![boxes[k]!]!;
          if (d >= 0) tryPerm(k + 1, sum + d);
          [perm[k], perm[i]] = [perm[i]!, perm[k]!];
        }
      };
      tryPerm(0, 0);
      return best === Infinity ? 1e9 : best;
    }
    let sum = 0;
    for (const b of boxes) {
      let d = Infinity;
      for (let gi = 0; gi < n; gi++) {
        const v = distToGoal[gi]![b]!;
        if (v >= 0 && v < d) d = v;
      }
      if (d === Infinity) return 1e9;
      sum += d;
    }
    return sum;
  };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // A state's key: its region's lowest square, then the boxes' squares. Small
  // rooms use one exact number, digits in base `size`; a whole level with many
  // boxes would overflow 2 ** 53 that way, so it uses a string instead.
  const keyOf = (boxes: number[], low: number): number | string => {
    if (n > 5) return `${low}:${boxes.join(',')}`;
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  const boxesOf: number[][] = [level.boxes.slice()];
  const playerOf: number[] = [level.player];
  const gOf: number[] = [0];
  const fOf: number[] = [heuristic(level.boxes)];
  const parentOf: number[] = [-1];
  const pushBoxOf: number[] = [-1];
  const pushDirOf: number[] = [-1];
  const done: number[] = [0];
  const best = new Map<number | string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  best.set(keyOf(level.boxes, regionLow(level, occupied, level.player, seen, ++stamp, stack)), 0);
  for (const b of level.boxes) occupied[b] = 0;

  // Binary heap of node indexes, ordered by (f, deeper g first, older first).
  const heap: number[] = [0];
  const before = (a: number, b: number): boolean =>
    fOf[a]! < fOf[b]! || (fOf[a]! === fOf[b]! && (gOf[a]! > gOf[b]! || (gOf[a]! === gOf[b]! && a < b)));
  const heapPush = (v: number): void => {
    let i = heap.length;
    heap.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && before(heap[c + 1]!, heap[c]!)) c++;
        if (!before(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  let found = -1;
  let spent = 0;
  while (heap.length > 0 && found < 0) {
    const s = heapPop();
    if (done[s]) continue;
    done[s] = 1;
    const boxes = boxesOf[s]!;
    if (solved(boxes)) {
      found = s;
      break;
    }
    if (spent >= maxExpansions || expansionsLeft <= 0) return null;
    spent++;
    expansionsLeft--;
    for (const b of boxes) occupied[b] = 1;
    regionLow(level, occupied, playerOf[s]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di]!;
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = -1;
        let next: number[] | null = null;
        let h = 0;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, regionLow(level, occupied, b, mark, ++stamp, stack));
          h = heuristic(next);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || h >= 1e9) continue;
        const ng = gOf[s]! + 1;
        const prev = best.get(key);
        if (prev !== undefined && gOf[prev]! <= ng) continue;
        best.set(key, boxesOf.length);
        boxesOf.push(next!);
        playerOf.push(b);
        gOf.push(ng);
        fOf.push(ng + h);
        parentOf.push(s);
        pushBoxOf.push(bi);
        pushDirOf.push(di);
        done.push(0);
        heapPush(boxesOf.length - 1);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The path of pushes, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parentOf[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  for (const s of path) {
    const nextBoxes = boxesOf[s]!;
    const bi = pushBoxOf[s]!;
    const di = pushDirOf[s]!;
    const from = boxes[bi]!;
    const d = DIRS[di]![1] * w + DIRS[di]![0];
    const to = from + d;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += DIRS[di]![3];
    player = from;
    boxes = nextBoxes;
  }
  return moves;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, the case aside) from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/** The level solved room by room, the other rooms' boxes standing as walls. */
function solveLevel(level: Level): string {
  const rooms = roomsOf(level);
  if (rooms === null) return solvePushOptimal(level, ROOM_EXPANSION_BUDGET) ?? '';
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushOptimal(sub, ROOM_EXPANSION_BUDGET);
    if (solved === null) return '';
    moves += solved;
    player = endOf(level.w, player, solved);
    // The room's boxes are on its goals now: they stay walls for the next rooms.
    for (let i = 0; i < room.boxes.length; i++) room.boxes[i] = room.goals[i]!;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    moves = solveLevel(parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8')));
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}

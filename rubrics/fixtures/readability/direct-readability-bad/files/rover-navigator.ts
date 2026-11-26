import type { GridBounds, Heading } from './compass';

const D = ['N', 'E', 'S', 'W'] as const;
const V: ReadonlyArray<readonly [number, number]> = [[0, 1], [1, 0], [0, -1], [-1, 0]];

export function run(s: string, p: [number, number, Heading], b: GridBounds): [number, number, Heading] {
  if (!/^(?:[LRM]{1,64})(?::[A-Z]{2}\d{2})?$/.test(s)) {
    throw new Error('bad');
  }
  const q = s.split(':')[0];
  let [x, y, d] = p;
  for (let i = 0; i < q.length; i += 1) {
    const c = q[i];
    const k = D.indexOf(d);
    if (c === 'L' || c === 'R') {
      d = D[(k + (c === 'R' ? 1 : 3)) & 3];
    } else {
      const nx = x + V[k][0];
      const ny = y + V[k][1];
      x = nx < 0 ? 0 : nx > b.maxX ? b.maxX : nx;
      y = ny < 0 ? 0 : ny > b.maxY ? b.maxY : ny;
    }
  }
  return [x, y, d];
}

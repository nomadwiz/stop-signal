// C3: estimates how far a vehicle is from the stop at an instant between feed updates (FR6, product.md §4 step 4).
// It carries the vehicle on along the trip's shape at the speed its last two reports give. Pure: the caller
// passes the instant, read from the injected Clock (ADR-002 rule 1). What it returns is ADR-022's.
export interface Point { lat: number; lon: number }
// at is when the vehicle measured its position, in epoch milliseconds.
export interface Fix extends Point { at: number }

const M_PER_DEGREE = 6_371_000 * (Math.PI / 180);
// AT's feed "is updated at least every 30 seconds" (m1-revised.md §1.4); a report older than that is stale input (ADR-022).
export const FEED_INTERVAL_MS = 30_000;
// The furthest a vehicle is taken to travel along its shape per second between two reports: well above any urban bus
// speed, and M1 is the same for any cap from 15 to 60 m/s (ADR-022 decision 5).
const MAX_SPEED_MPS = 25;

// distanceM and speedMps are measured along the shape; distanceM is negative once the vehicle is predicted past the stop.
// stale is true when the latest report is more than one feed interval old at now. alongM is where the latest report sits
// along the shape; the caller passes it back as previousAlongM with the vehicle's next report on the same trip. Without
// previousAlongM, as for a trip's first pair, both reports are matched over the whole shape.
export function predict(
  shape: Point[], stop: Point, previous: Fix, latest: Fix, now: number, previousAlongM?: number,
): { distanceM: number; speedMps: number; stale: boolean; alongM: number } {
  if (shape.length < 2) throw new RangeError(`a shape of ${shape.length} points has no line to measure along`);
  if (!(latest.at > previous.at)) throw new RangeError(`latest report at ${latest.at} is not after the previous one at ${previous.at}`);
  const { xy, segments, stops } = projected(shape);

  // Metres along the shape to the point on it nearest p, among the segments that reach fromM, and no further than toM.
  const along = (p: Point, fromM = 0, toM = Infinity) => {
    const [x, y] = xy(p);
    let best = { d: Infinity, m: 0 };
    // The first segment that reaches fromM, by bisection: segment ends only grow along the shape.
    let lo = 0;
    for (let hi = segments.length; lo < hi;) {
      const mid = (lo + hi) >> 1;
      if (segments[mid].start + segments[mid].length < fromM) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < segments.length; i++) {
      const { ax, ay, dx, dy, length, start } = segments[i];
      if (start > toM) break;
      const f = length ? Math.min(1, (toM - start) / length, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (length * length))) : 0;
      const d = Math.hypot(ax + f * dx - x, ay + f * dy - y);
      if (d < best.d) best = { d, m: start + f * length };
    }
    return best.m;
  };
  const stopM = stops.get(stop) ?? stops.set(stop, along(stop)).get(stop)!;

  // Given the carried match, matched on from it, no further than MAX_SPEED_MPS allows, so a shape that runs along one
  // road twice keeps the vehicle on the pass it is on; without it, nearest over the whole shape (ADR-022 decision 5).
  const first = previousAlongM ?? along(previous);
  const intervalS = (latest.at - previous.at) / 1000;
  const last = previousAlongM === undefined ? along(latest) : along(latest, first, first + MAX_SPEED_MPS * intervalS);
  // Clamped at 0: a bus does not reverse along its trip, and a dwelling bus's fixes jitter backwards (ADR-022).
  const speedMps = Math.max(0, (last - first) / intervalS);
  // Clamped at 0: a vehicle's timestamp can run 1–2 s past the instant, and nothing is predicted backwards
  // (ADR-022, decided 05-10-2026).
  const ageS = Math.max(0, now - latest.at) / 1000;
  return { distanceM: stopM - last - speedMps * ageS, speedMps, stale: ageS > FEED_INTERVAL_MS / 1000, alongM: last };
}

// Each shape's segments in flat-earth metres about its first point, as actual-calls.ts does, good to well under a metre
// across a city; and each stop's match along it. Computed once per shape and stop object and kept while the shape is,
// so a carried match scans only the segments it can reach: a replay of the fixture window predicts about 46,000 times.
// ponytail: keyed by object, so a shape or stop mutated in place keeps its old projection; nothing mutates them.
const cache = new WeakMap<readonly Point[], ReturnType<typeof project>>();
const projected = (shape: readonly Point[]) => cache.get(shape) ?? cache.set(shape, project(shape)).get(shape)!;
function project(shape: readonly Point[]) {
  const kx = M_PER_DEGREE * Math.cos((shape[0].lat * Math.PI) / 180);
  const xy = ({ lat, lon }: Point) => [(lon - shape[0].lon) * kx, (lat - shape[0].lat) * M_PER_DEGREE];
  const points = shape.map(xy);
  const segments = [];
  let start = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i];
    const dx = points[i + 1][0] - ax;
    const dy = points[i + 1][1] - ay;
    const length = Math.hypot(dx, dy);
    segments.push({ ax, ay, dx, dy, length, start });
    start += length;
  }
  return { xy, segments, stops: new WeakMap<Point, number>() };
}

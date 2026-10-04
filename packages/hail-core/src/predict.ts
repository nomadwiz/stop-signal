// C3: estimates how far a vehicle is from the stop at an instant between feed updates (FR6, product.md §4 step 4).
// It carries the vehicle on along the trip's shape at the speed its last two reports give. Pure: the caller
// passes the instant, read from the injected Clock (ADR-002 rule 1). What it returns is ADR-022's.
export interface Point { lat: number; lon: number }
// at is when the vehicle measured its position, in epoch milliseconds.
export interface Fix extends Point { at: number }

const M_PER_DEGREE = 6_371_000 * (Math.PI / 180);
// AT's feed "is updated at least every 30 seconds" (m1-revised.md §1.4); a report older than that is stale input (ADR-022).
const FEED_INTERVAL_MS = 30_000;

// distanceM and speedMps are measured along the shape; distanceM is negative once the vehicle is predicted past the stop.
// stale is true when the latest report is more than one feed interval old at now.
export function predict(shape: Point[], stop: Point, previous: Fix, latest: Fix, now: number): { distanceM: number; speedMps: number; stale: boolean } {
  if (shape.length < 2) throw new RangeError(`a shape of ${shape.length} points has no line to measure along`);
  if (!(latest.at > previous.at)) throw new RangeError(`latest report at ${latest.at} is not after the previous one at ${previous.at}`);
  // ponytail: flat-earth metres about the shape's first point, as actual-calls.ts does; good to well under a metre across a city.
  const kx = M_PER_DEGREE * Math.cos((shape[0].lat * Math.PI) / 180);
  const xy = ({ lat, lon }: Point) => [(lon - shape[0].lon) * kx, (lat - shape[0].lat) * M_PER_DEGREE];
  const points = shape.map(xy);

  // Metres along the shape to the point on it nearest p.
  // ponytail: nearest over the whole shape, so a shape that passes one place twice can match the wrong pass;
  // search on from the previous report's match if a loop ever does.
  const along = (p: Point) => {
    const [x, y] = xy(p);
    let best = { d: Infinity, m: 0 };
    let start = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, ay] = points[i];
      const [bx, by] = points[i + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const length = Math.hypot(dx, dy);
      const f = length ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (length * length))) : 0;
      const d = Math.hypot(ax + f * dx - x, ay + f * dy - y);
      if (d < best.d) best = { d, m: start + f * length };
      start += length;
    }
    return best.m;
  };

  const last = along(latest);
  // Clamped at 0: a bus does not reverse along its trip, and a dwelling bus's fixes jitter backwards (ADR-022).
  const speedMps = Math.max(0, (last - along(previous)) / ((latest.at - previous.at) / 1000));
  // Clamped at 0: a vehicle's timestamp can run 1–2 s past the instant, and nothing is predicted backwards
  // (ADR-022, decided 05-10-2026).
  const ageS = Math.max(0, now - latest.at) / 1000;
  return { distanceM: along(stop) - last - speedMps * ageS, speedMps, stale: ageS > FEED_INTERVAL_MS / 1000 };
}

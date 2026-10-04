// C2: the latest instant at which a signal is still useful, and the margin left before it
// (#29, FR7, QR6, doc/output/m1-revised.md §1.4, ADR-023). Speeds in m/s, distances in m, instants in epoch ms.
// t_pr = 2.0 s and a ∈ [0.9, 1.47] m/s² are m1-revised.md §1.4's cited values. a is required here; ADR-023 decision 2
// sets DECEL_MPS2 = 0.9 where the service configures the loop, the value behind QR1's 17.4 s bound (R2 §2).

const T_PR = 2.0;

// D = t_pr + v/a: seconds from the signal reaching the driver to the vehicle standing at the stop.
export function stoppingBudget(speed: number, decel: number): number {
  if (!(decel >= 0.9 && decel <= 1.47)) throw new RangeError(`decel ${decel} outside 0.9–1.47 m/s²`);
  return T_PR + speed / decel;
}

// The deadline falls where the distance to the stop equals the stopping distance, t_pr at speed v then v²/2a
// of braking (ADR-023; doc/plan/m1/06-r2-sourcing.md §2's distance column). null means send nothing: the
// deadline has passed (QR6), the vehicle is stationary or already stopping (S6, not built), or an input is NaN.
export function signalDeadline(
  now: number,
  distanceToStop: number,
  speed: number,
  decel: number,
): { deadline: number; margin: number } | null {
  if (!(decel >= 0.9 && decel <= 1.47)) throw new RangeError(`decel ${decel} outside 0.9–1.47 m/s²`);
  if (!(speed > 0)) return null;
  const stoppingDistance = speed * T_PR + (speed * speed) / (2 * decel);
  const margin = ((distanceToStop - stoppingDistance) / speed) * 1000;
  return margin >= 0 ? { deadline: now + margin, margin } : null;
}

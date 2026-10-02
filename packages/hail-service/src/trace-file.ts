// C10's store: appends each decision to a JSON Lines file (ADR-015 decision 4), the log T7 compares byte for byte.
import { appendFileSync } from 'node:fs';
import type { TraceSink } from '../../hail-core/src/trace.ts';

// ponytail: opens the file on every append and leaves flushing to the OS. A few decisions per
// feed tick is nothing; hold one descriptor if the rate grows, and fsync if a power cut must not cost the tail.
export function fileTraceSink(path: string): TraceSink {
  return {
    append({ seq, at, kind, hailId, vehicleId, payload }) {
      // Built afresh so the keys are always in this order, whatever order the record arrived in.
      appendFileSync(path, JSON.stringify({ seq, at, kind, hailId, vehicleId, payload }) + '\n');
    },
  };
}

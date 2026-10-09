// The replay's scenarios of one size and each one's expected decision log, for the measurement scripts (m1, m4a, m4b).
// Reads packages/replay/scenarios/ and packages/replay/expected/, one run per D, widest D first.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Scenario } from './scenarios.ts';

export function replayRuns(suffix: string): { d: string; files: string[]; built: Scenario[]; logs: string[][] }[] {
  const replay = (path: string) => fileURLToPath(new URL(`../../replay/${path}`, import.meta.url));
  return readdirSync(replay('scenarios')).sort((a, b) => Number(b.slice(1)) - Number(a.slice(1))).map((d) => {
    const files = readdirSync(replay(`scenarios/${d}`)).filter((f) => f.endsWith(suffix)).sort();
    const built: Scenario[] = files.map((f) => JSON.parse(readFileSync(replay(`scenarios/${d}/${f}`), 'utf8')));
    const logs = files.map((f) => readFileSync(replay(`expected/${d}/${f.replace(/\.json$/, '.jsonl')}`), 'utf8').split('\n').filter(Boolean));
    return { d, files, built, logs };
  });
}

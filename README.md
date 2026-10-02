# StopSignal

The build for StopSignal, which hails the correct approaching Auckland bus for a passenger at a stop using only Auckland Transport's published data.

## The documents

The design, its decisions and the reports are in `nomadwiz/stop-signal-doc`. Clone that repository and clone this one into its `code/` folder:

    git clone https://github.com/nomadwiz/stop-signal-doc.git comp826-a2
    git clone https://github.com/nomadwiz/stop-signal.git comp826-a2/code

## Running

Node.js 22.18 or later in the 22 LTS line, which runs TypeScript by stripping types, and npm.

    npm ci
    npm test            # Vitest, every workspace
    npm run lint        # ESLint, including the clock and import bans in hail-core
    npm run typecheck   # tsc, no output

## Where files belong

| Path | What goes there |
| --- | --- |
| `packages/hail-core/` | The deciding core and its ports. No runtime dependencies and no clock reads |
| `packages/hail-service/` | The service process and its adapters |
| `packages/console/` | The stand-in driver console |
| `packages/feed-capture/` | The GTFS-Realtime poller that archives raw snapshots |
| `packages/replay/` | The replay harness |
| `infra/` | Scripts that stand up and check the AWS hosts |
| `test/` | Guards over the whole repository |

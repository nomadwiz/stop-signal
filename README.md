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
    npm run replay:check  # T7: replays every scenario over the fixtures; add `-- --write` to accept changed logs

The passenger app needs Xcode 16 or later, and its tests run on an iPhone simulator. The `iPhone 17` simulator ships with Xcode 26 and later; with an older Xcode, name an iPhone it provides:

    xcodebuild test -project ios/StopSignal.xcodeproj -scheme StopSignal -destination 'platform=iOS Simulator,name=iPhone 17'

The app addresses the deployed service, `https://52-64-33-196.sslip.io`. The simulator shares the Mac's network, so to run the app against a service on the Mac instead, start it and launch the installed app with `STOPSIGNAL_BASE_URL` in its environment, or set that variable in the StopSignal scheme's Run arguments in Xcode:

    PORT=8080 node packages/hail-service/src/main.ts
    SIMCTL_CHILD_STOPSIGNAL_BASE_URL=http://localhost:8080 xcrun simctl launch booted com.nomadwiz.StopSignal

B7's cold-start times (ADR-046) run by hand from the `StopSignalUITests` scheme, with the hail service running locally; `ios/StopSignalUITests/ColdStartTests.swift` gives the commands.

## Where files belong

| Path | What goes there |
| --- | --- |
| `packages/hail-core/` | The deciding core and its ports. No runtime dependencies and no clock reads |
| `packages/hail-service/` | The service process and its adapters |
| `packages/console/` | The stand-in driver console |
| `packages/feed-capture/` | The GTFS-Realtime poller that archives raw snapshots |
| `packages/replay/` | The replay harness |
| `ios/` | The passenger app. `ios/StopSignal/tokens.json` is a byte-identical copy of the documents repository's `doc/design/design-system/tokens.json`. `ios/StopSignal/stops.json` is cut from the deployed service's timetable by `ios/cut-stops.ts`, whose usage comment gives the commands. `ios/StopSignalWidget/` is the widget extension that draws the live activity; it also builds `ios/StopSignal/HailActivity.swift`, `Tokens.swift` and `tokens.json` |
| `infra/` | Scripts that stand up and check the AWS hosts |
| `test/` | Guards over the whole repository |

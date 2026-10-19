# StopSignal

The build for StopSignal, which hails the correct approaching Auckland bus for a passenger at a stop using only Auckland Transport's published data.

## The documents

The design, its decisions and the reports are in `nomadwiz/stop-signal-doc`. Clone that repository and clone this one into its `code/` folder:

    git clone https://github.com/nomadwiz/stop-signal-doc.git comp826-a2
    git clone https://github.com/nomadwiz/stop-signal.git comp826-a2/code

## Running

Node.js 22.18 or later in the 22 LTS line, which runs TypeScript by stripping types, and npm. Every command runs from the build's root.

    npm ci
    npm test            # Vitest, every workspace
    npm run lint        # ESLint, including the clock and import bans in hail-core
    npm run typecheck   # tsc, no output
    npm run replay:check  # T7: replays every scenario over the fixtures; add `-- --write` to accept changed logs

### The hail service and the driver console

The service loads today's Auckland service day from Auckland Transport's published timetable, and polls Auckland Transport's live feed every 20 s with a subscription key of your own from its developer portal, <https://dev-portal.at.govt.nz>. `read -s` keeps the key out of your shell history; never commit it. Without `AT_KEY` the service polls nothing, so no bus arrives.

    curl -fsSLo /tmp/gtfs.zip https://gtfs.at.govt.nz/gtfs.zip
    read -rs AT_KEY && export AT_KEY
    GTFS_ZIP=/tmp/gtfs.zip PORT=8080 node packages/hail-service/src/main.ts

It logs to stderr and writes each decision to stdout as a JSON line. In a second terminal, serve the console, then open <http://localhost:5173>; it shows each signal the service sends while it is open:

    npm run dev -w @stopsignal/console

The deployed service is `https://52-64-33-196.sslip.io`. Its console is password-protected, and the password is the owner's.

### The passenger app

Xcode 16 or later, selected as the developer directory: `xcode-select -p` must print a path inside Xcode, not `/Library/Developer/CommandLineTools`. If it does not, run `sudo xcode-select -s /Applications/Xcode.app`. The `iPhone 17` simulator ships with Xcode 26 and later; with an older Xcode, name an iPhone it provides.

    xcodebuild test -project ios/StopSignal.xcodeproj -scheme StopSignal -destination 'platform=iOS Simulator,name=iPhone 17'

To run it, open `ios/StopSignal.xcodeproj` in Xcode, choose the `StopSignal` scheme and an iPhone simulator, and press Run. The app addresses the deployed service. To address the service on the Mac instead, which the simulator reaches as `localhost`, set `STOPSIGNAL_BASE_URL` to `http://localhost:8080` under Product → Scheme → Edit Scheme → Run → Arguments → Environment Variables, or relaunch the installed app with it:

    SIMCTL_CHILD_STOPSIGNAL_BASE_URL=http://localhost:8080 xcrun simctl launch --terminate-running-process booted com.nomadwiz.StopSignal

To stand at a stop, choose Features → Location → Custom Location in the Simulator and enter Melrose Street, stop 7177: latitude `-36.86698`, longitude `174.77468`.

To build onto an iPhone:

1. Sign in with an Apple ID under Xcode → Settings → Accounts.
2. Connect the iPhone to the Mac. On the iPhone, turn on Settings → Privacy & Security → Developer Mode, which appears once Xcode has seen the phone, and restart it.
3. In the project's Signing & Capabilities tab, for both the `StopSignal` and `StopSignalWidget` targets, tick Automatically manage signing and choose your team. If Xcode says the bundle identifier is taken, change `com.nomadwiz.StopSignal` to one of your own, and the widget's to start with it, such as `<yours>.Widget`.
4. Choose the iPhone as the run destination, and press Run.
5. On the iPhone, trust the developer under Settings → General → VPN & Device Management, then open the app.

A free Apple ID's signing lasts 7 days, after which you run it again from Xcode. The iPhone cannot reach a service on the Mac, which listens on 127.0.0.1 alone, so it uses the deployed service. To stand at a stop without going there, save this as `melrose.gpx` and, while the app runs, choose it through Debug → Simulate Location → Add GPX File to Project:

    <gpx version="1.1"><wpt lat="-36.86698" lon="174.77468"/></gpx>

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

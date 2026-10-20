# StopSignal

StopSignal lets a passenger waiting at an Auckland bus stop hail the right approaching bus from their iPhone. It works out which bus that is from Auckland Transport's published timetable and live feed alone, signals the driver, and tells the passenger whether the hail got through.

It has three parts: a hail service in Node.js, a driver console in the browser, and a passenger app for iOS.

## Contents

- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Quick start, with no Auckland Transport key](#quick-start-with-no-auckland-transport-key)
- [Run the hail service with live buses](#run-the-hail-service-with-live-buses)
- [Open the driver console](#open-the-driver-console)
- [Run the passenger app in the iOS Simulator](#run-the-passenger-app-in-the-ios-simulator)
- [Run the passenger app on an iPhone](#run-the-passenger-app-on-an-iphone)
- [Troubleshooting](#troubleshooting)

## Repository layout

| Path | What it holds |
| --- | --- |
| `packages/hail-core/` | The deciding core and its ports. No runtime dependencies and no clock reads |
| `packages/hail-service/` | The service process and its adapters |
| `packages/console/` | The stand-in driver console |
| `packages/feed-capture/` | The GTFS-Realtime poller that archives raw feed snapshots |
| `packages/replay/` | The replay harness, its recorded snapshots, scenarios and expected decision logs |
| `ios/` | The passenger app (`StopSignal`), its live-activity widget (`StopSignalWidget`) and their tests |
| `infra/` | Scripts that stand up and check the AWS hosts |
| `test/` | Guards over the whole repository |
| `.github/workflows/` | Continuous integration and the automated pull request review |

## Prerequisites

- **Node.js 22.18 or later in the 22 line**, with npm. Node runs the TypeScript directly by stripping types, so there is no build step.
- **Xcode 26 or later**, for the passenger app only. The commands below use the `iPhone 17` simulator, which first shipped with Xcode 26.
- **An Auckland Transport subscription key**, for live buses only. Get one from the developer portal at <https://dev-portal.at.govt.nz>. The tests and the replay check need none.

## Quick start, with no Auckland Transport key

1. Clone the repository and enter it. Every command in this README runs from here.

   ```sh
   git clone https://github.com/nomadwiz/stop-signal.git
   cd stop-signal
   ```

2. Install the exact dependencies in `package-lock.json`.

   ```sh
   npm ci
   ```

3. Run the test suite, Vitest across every workspace.

   ```sh
   npm test
   ```

4. Run the replay check. It replays every recorded scenario through the production decision loop and compares each decision log byte for byte with its expected log. It ends with `T7 passes: every decision log is byte-identical to its expected log.`

   ```sh
   npm run replay:check
   ```

Two more checks run in continuous integration:

```sh
npm run lint        # ESLint, including the clock and import bans in hail-core
npm run typecheck   # tsc, which prints nothing when it passes
```

## Run the hail service with live buses

The service loads today's Auckland service day from Auckland Transport's published timetable and polls the live feed every 20 seconds with your key. Without `AT_KEY` it starts and listens but polls nothing, so no bus ever arrives.

1. Download the timetable.

   ```sh
   curl -fsSLo /tmp/gtfs.zip https://gtfs.at.govt.nz/gtfs.zip
   ```

2. Read your key into the shell. `read -rs` takes it without showing it or keeping it in your shell history: paste it and press Return. Never commit it.

   ```sh
   read -rs AT_KEY && export AT_KEY
   ```

3. Start the service.

   ```sh
   GTFS_ZIP=/tmp/gtfs.zip PORT=8080 node packages/hail-service/src/main.ts
   ```

It is ready when it prints `hail service listening on 127.0.0.1:8080`. It listens on 127.0.0.1 only, and writes each decision to standard output as one line of JSON.

## Open the driver console

The console needs the hail service running on port 8080, which it proxies to.

1. In a second terminal, from the repository root, serve the console.

   ```sh
   npm run dev -w @stopsignal/console
   ```

2. Open <http://localhost:5173>. It shows each signal the service sends while the page is open.

## Run the passenger app in the iOS Simulator

1. Check that the command-line tools point at Xcode. `xcode-select -p` must print a path inside Xcode, not `/Library/Developer/CommandLineTools`. If it does not, select Xcode:

   ```sh
   sudo xcode-select -s /Applications/Xcode.app
   ```

2. Install the iOS platform, if Xcode has not already offered it on first launch.

   ```sh
   xcodebuild -downloadPlatform iOS
   ```

3. Optionally, run the app's tests.

   ```sh
   xcodebuild test -project ios/StopSignal.xcodeproj -scheme StopSignal -destination 'platform=iOS Simulator,name=iPhone 17'
   ```

4. Open `ios/StopSignal.xcodeproj` in Xcode, choose the `StopSignal` scheme and the `iPhone 17` simulator, and press Run.

5. Stand the simulator at Melrose Street, stop 7177. In the Simulator, choose Features → Location → Custom Location and enter latitude `-36.86698`, longitude `174.77468`.

### Which service the app uses

The app addresses the deployed service at `https://52-64-33-196.sslip.io`. That service runs continuously while the COMP826 Milestone 2 report is being marked, so the app works without an Auckland Transport key. Outside that period it runs only during the owner's field-test windows. Its console's password is the owner's.

To use the service running on your Mac instead, start it as in [Run the hail service with live buses](#run-the-hail-service-with-live-buses), run the app once from Xcode so it is installed, then relaunch it with `STOPSIGNAL_BASE_URL` set. The simulator reaches the Mac as `localhost`.

```sh
SIMCTL_CHILD_STOPSIGNAL_BASE_URL=http://localhost:8080 xcrun simctl launch --terminate-running-process booted com.nomadwiz.StopSignal
```

An empty `STOPSIGNAL_BASE_URL` falls back to the deployed service.

## Run the passenger app on an iPhone

1. Sign in with an Apple ID under Xcode → Settings → Accounts.
2. Connect the iPhone to the Mac. On the iPhone, turn on Settings → Privacy & Security → Developer Mode, which appears once Xcode has seen the phone, and restart it.
3. In the project's Signing & Capabilities tab, choose your team for both the `StopSignal` and `StopSignalWidget` targets; automatic signing is already on. Xcode will say `com.nomadwiz.StopSignal` is taken: change it to a bundle identifier of your own, and the widget's to start with it, such as `<yours>.Widget`.
4. Choose the iPhone as the run destination, and press Run.
5. On the iPhone, trust the developer under Settings → General → VPN & Device Management, then open the app.

A free Apple ID's signing lasts 7 days, after which you run it again from Xcode.

The iPhone cannot reach a service on the Mac, which listens on 127.0.0.1 alone, so it needs the deployed service to be running.

To stand at a stop without going there, save this as `~/melrose.gpx`. While the app runs, add it through Debug → Simulate Location → Add GPX File to Project, then choose `melrose` from the same menu.

```xml
<gpx version="1.1" creator="StopSignal" xmlns="http://www.topografix.com/GPX/1/1"><wpt lat="-36.86698" lon="174.77468"/></gpx>
```

Choosing a team and adding the GPX file change `ios/StopSignal.xcodeproj`. Undo them with `git restore ios/StopSignal.xcodeproj` rather than committing them.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `xcodebuild` says the active developer directory is a command line tools instance | Run `sudo xcode-select -s /Applications/Xcode.app` |
| `Unable to find a destination matching … name=iPhone 17` | Xcode is older than 26, or the iOS platform is missing. Update Xcode, or run `xcodebuild -downloadPlatform iOS` |
| The service runs, but no bus ever arrives | `AT_KEY` is unset, so nothing is polled, or `GTFS_ZIP` is unset, so the timetable is empty |
| The console shows nothing | The hail service is not running on port 8080 |
| The app shows "No connection" or "Can't reach StopSignal" | The deployed service is not running. Point the simulator at a local service, as in [Which service the app uses](#which-service-the-app-uses) |
| `npm test` reports one test skipped | Expected. `ios/cut-stops.test.ts` checks the app's bundled stop list against the deployed service's timetable, and runs only with `GTFS_ZIP` set |

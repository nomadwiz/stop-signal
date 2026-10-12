// signals.md's sounds and haptics for the Armed screen's changes. Each signal is one Core Haptics pattern on a
// `.playback` audio session that mixes with other audio, so the heads-up plays through the silent switch; the ticks
// are system sounds, which follow the ringer switch (signals.md §Rules). VoiceOver announces the change once the sound
// has finished.
import AVFoundation
import AudioToolbox
import CoreHaptics
import SwiftUI

enum Cue {
    case tap, tick, ticks, headsUp, none

    // How long the sound lasts, after which VoiceOver speaks.
    var length: Duration {
        switch self {
        case .tap, .none: .zero
        case .tick: .milliseconds(100)
        case .ticks: .milliseconds(250)
        case .headsUp: .milliseconds(500)
        }
    }
}

@MainActor
enum Signals {
    // ponytail: system sound 1103 ("Tink") as the soft tick, and a 150 ms gap between two ticks or taps, which
    // signals.md does not give. Change either here if a device check finds it wrong.
    private static let tick: SystemSoundID = 1103
    private static let gap = 0.15

    // Nil where the hardware has no haptics, as in the simulator; the cue then plays its ticks alone.
    private static let engine: CHHapticEngine? = {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, options: .mixWithOthers)
        try? session.setActive(true)
        return try? CHHapticEngine(audioSession: session)
    }()

    static func play(_ cue: Cue, announcing text: String) {
        let tap = { (at: Double) in
            CHHapticEvent(eventType: .hapticTransient, parameters: [.init(parameterID: .hapticIntensity, value: 0.4), .init(parameterID: .hapticSharpness, value: 0.3)], relativeTime: at)
        }
        // The heads-up: a 300 ms pulse and note at medium intensity on one mid pitch, then a short tap and a 100 ms
        // note, 100 ms after.
        let note = { (at: Double, length: Double) in
            CHHapticEvent(eventType: .audioContinuous, parameters: [.init(parameterID: .audioPitch, value: 0), .init(parameterID: .audioVolume, value: 0.8)], relativeTime: at, duration: length)
        }
        let medium = [CHHapticEventParameter(parameterID: .hapticIntensity, value: 0.6)]
        let events: [CHHapticEvent] = switch cue {
        case .tap, .tick: [tap(0)]
        case .ticks: [tap(0), tap(gap)]
        case .headsUp: [
            CHHapticEvent(eventType: .hapticContinuous, parameters: medium, relativeTime: 0, duration: 0.3), note(0, 0.3),
            CHHapticEvent(eventType: .hapticTransient, parameters: medium, relativeTime: 0.4), note(0.4, 0.1),
        ]
        case .none: []
        }
        if let engine, !events.isEmpty {
            try? engine.start()
            try? engine.makePlayer(with: CHHapticPattern(events: events, parameters: [])).start(atTime: CHHapticTimeImmediate)
        }
        if cue == .tick || cue == .ticks { AudioServicesPlaySystemSound(tick) }
        if cue == .ticks {
            Task {
                try? await Task.sleep(for: .seconds(gap))
                AudioServicesPlaySystemSound(tick)
            }
        }
        Task {
            try? await Task.sleep(for: cue.length)
            var spoken = AttributedString(text)
            spoken.accessibilitySpeechAnnouncementPriority = .high
            AccessibilityNotification.Announcement(spoken).post()
        }
    }
}

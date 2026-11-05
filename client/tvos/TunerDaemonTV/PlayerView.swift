import AVKit
import SwiftUI
import UIKit

struct PlayerView: View {
    let channel: Channel
    let serverURL: String

    @Environment(\.dismiss) private var dismiss
    @State private var player: AVPlayer?
    @State private var error: String?
    @State private var keepAliveTask: Task<Void, Never>?
    @State private var watchdogTask: Task<Void, Never>?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let player {
                PlayerViewController(player: player) {
                    dismiss()
                }
                .ignoresSafeArea()
            } else {
                VStack(spacing: 18) {
                    ProgressView()
                    Text("Tuning \(channel.name)…")
                        .font(.system(size: 26))
                }
            }

            if let error {
                VStack(spacing: 20) {
                    Text(error)
                        .font(.system(size: 24))
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 900)

                    Button("Back to channels") {
                        dismiss()
                    }
                }
                .padding(40)
                .background(.black.opacity(0.8), in: RoundedRectangle(cornerRadius: 20))
            }
        }
        .onAppear(perform: start)
        .onDisappear(perform: stop)
    }

    private func start() {
        guard let base = URL(string: serverURL.hasSuffix("/") ? serverURL : serverURL + "/"),
              let url = URL(string: channel.streamURL, relativeTo: base)?.absoluteURL else {
            error = "This channel has no stream URL."
            return
        }

        let item = AVPlayerItem(url: url)
        let player = AVPlayer(playerItem: item)
        self.player = player
        player.play()

        let channelID = channel.id
        let server = serverURL
        keepAliveTask = Task { [channelID, server] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                if Task.isCancelled { break }
                if let api = APIClient(serverURL: server) {
                    await api.keepAlive(channelID: channelID)
                }
            }
        }

        // The web player uses the same 12-second budget before calling a
        // channel unresponsive. AVPlayer otherwise sits on a black screen.
        watchdogTask = Task { [player] in
            try? await Task.sleep(nanoseconds: 12_000_000_000)
            if Task.isCancelled { return }
            if player.timeControlStatus != .playing,
               player.currentItem?.status != .readyToPlay {
                self.error = "This channel is not responding. It may be offline, or the stream may have moved."
            }
        }
    }

    private func stop() {
        watchdogTask?.cancel()
        watchdogTask = nil
        keepAliveTask?.cancel()
        keepAliveTask = nil
        player?.pause()
        player = nil
    }
}

/// AVPlayerViewController already gives tvOS the native transport bar, Siri
/// Remote play/pause and scrubbing. The only addition is Menu to leave playback.
final class TunerPlayerViewController: AVPlayerViewController {
    var onExit: (() -> Void)?

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if presses.contains(where: { $0.type == .menu }) {
            onExit?()
            return
        }
        super.pressesBegan(presses, with: event)
    }
}

struct PlayerViewController: UIViewControllerRepresentable {
    let player: AVPlayer
    let onExit: () -> Void

    func makeUIViewController(context: Context) -> TunerPlayerViewController {
        let controller = TunerPlayerViewController()
        controller.player = player
        controller.showsPlaybackControls = true
        controller.onExit = onExit
        return controller
    }

    func updateUIViewController(_ uiViewController: TunerPlayerViewController, context: Context) {}
}

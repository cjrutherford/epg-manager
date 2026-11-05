import SwiftUI

/// The TV client is native because tvOS has no public WebView. This is the
/// smallest useful slice of parity: connect to a server, list its live
/// channels, and play one with AVPlayer.
struct ContentView: View {
    @EnvironmentObject private var store: GuideStore
    @State private var selected: Channel?

    var body: some View {
        NavigationView {
            Group {
                if store.channels.isEmpty {
                    ServerSetupView()
                } else {
                    ChannelGridView(selected: $selected)
                }
            }
        }
        .fullScreenCover(item: $selected) { channel in
            PlayerView(channel: channel, serverURL: store.serverURL)
        }
        .task {
            await store.loadIfNeeded()
        }
    }
}

import SwiftUI

/// Scaffold for the native Apple TV client.
///
/// tvOS ships no public WebView: `UIWebView` is prohibited and WebKit is not
/// part of the tvOS SDK. The Apple TV client therefore has to be native. This
/// view is the placeholder that keeps the target and CI green while the guide,
/// player and DVR screens are built against the same REST API the web and
/// Android clients use.
struct ContentView: View {
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 28) {
                Image(systemName: "tv")
                    .font(.system(size: 88, weight: .thin))
                    .foregroundStyle(.secondary)

                Text("Tuner Daemon")
                    .font(.system(size: 64, weight: .bold))

                Text("The native Apple TV client is being built on this branch.")
                    .font(.system(size: 28))
                    .foregroundStyle(.secondary)

                Text("tvOS has no WebView, so this target uses SwiftUI and AVPlayer against the same Tuner Daemon API as the phone, web and Android TV apps.")
                    .font(.system(size: 22))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 1100)
            }
            .padding(80)
        }
    }
}

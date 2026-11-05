import SwiftUI

@main
struct TunerDaemonTVApp: App {
    @StateObject private var store = GuideStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
        }
    }
}

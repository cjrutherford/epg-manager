import Foundation

@MainActor
final class GuideStore: ObservableObject {
    static let defaultServer = "https://teevee.christopherrutherford.net"
    private static let serverKey = "tuner_daemon_server_url"

    @Published var channels: [Channel] = []
    @Published var isLoading = false
    @Published var error: String?
    @Published var serverURL: String

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        serverURL = defaults.string(forKey: Self.serverKey) ?? Self.defaultServer
    }

    var api: APIClient? {
        APIClient(serverURL: serverURL)
    }

    func loadIfNeeded() async {
        guard channels.isEmpty else { return }
        await load()
    }

    func load() async {
        guard let api else {
            error = APIClient.APIError.invalidServer.localizedDescription
            return
        }

        isLoading = true
        error = nil

        do {
            let loaded = try await api.guide()
            channels = loaded
            defaults.set(serverURL, forKey: Self.serverKey)
        } catch {
            self.error = error.localizedDescription
        }

        isLoading = false
    }

    func connect(to value: String) async {
        serverURL = value.trimmingCharacters(in: .whitespacesAndNewlines)
        channels = []
        await load()
    }

    /// Return to server setup without losing the last good URL as the default.
    func resetServer() {
        channels = []
        error = nil
    }
}

import Foundation

/// The public API the TV client uses. `/api/guide` and the stream redirect are
/// intentionally unauthenticated, so a player does not need the admin password.
struct APIClient {
    let baseURL: URL

    enum APIError: LocalizedError {
        case invalidServer
        case badStatus(Int)

        var errorDescription: String? {
            switch self {
            case .invalidServer:
                return "Enter a valid http(s) server address."
            case .badStatus(let code):
                return "The server answered with HTTP \(code)."
            }
        }
    }

    init?(serverURL: String) {
        let trimmed = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host != nil else {
            return nil
        }
        baseURL = trimmed.hasSuffix("/") ? url : URL(string: trimmed + "/") ?? url
    }

    func guide(hours: Int = 6) async throws -> [Channel] {
        guard var components = URLComponents(
            url: baseURL.appendingPathComponent("api/guide"),
            resolvingAgainstBaseURL: false
        ) else {
            throw APIError.invalidServer
        }
        components.queryItems = [URLQueryItem(name: "hours", value: String(hours))]
        guard let url = components.url else { throw APIError.invalidServer }

        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidServer
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.badStatus(http.statusCode)
        }
        return try JSONDecoder().decode(GuideResponse.self, from: data).channels
    }

    /// HLS segment requests also bump the server's keep-alive, but a slow or
    /// paused stream can outlive the idle timeout without generating one.
    func keepAlive(channelID: String) async {
        guard let encoded = channelID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: "api/stream/keepalive/\(encoded)", relativeTo: baseURL) else {
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        _ = try? await URLSession.shared.data(for: request)
    }
}

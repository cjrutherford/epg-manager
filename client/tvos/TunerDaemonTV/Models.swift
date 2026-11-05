import Foundation

/// The subset of `/api/guide` a TV player needs.
struct GuideResponse: Decodable {
    let channels: [Channel]
}

struct Channel: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let groupTitle: String?
    let channelNumber: String?
    let logo: String?
    let streamURL: String
    let currentProgram: Program?
    let programs: [Program]

    enum CodingKeys: String, CodingKey {
        case id, name, logo, programs
        case groupTitle = "group_title"
        case channelNumber = "channel_number"
        case streamURL = "stream_url"
        case currentProgram = "current_program"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // SQLite ids and channel numbers are numbers; the web client
        // normalises them to strings. Accept either shape here too.
        id = container.flexibleString(forKey: .id) ?? UUID().uuidString
        name = try container.decode(String.self, forKey: .name)
        groupTitle = try container.decodeIfPresent(String.self, forKey: .groupTitle)
        channelNumber = container.flexibleString(forKey: .channelNumber)
        logo = try container.decodeIfPresent(String.self, forKey: .logo)
        streamURL = try container.decode(String.self, forKey: .streamURL)
        currentProgram = try container.decodeIfPresent(Program.self, forKey: .currentProgram)
        programs = try container.decodeIfPresent([Program].self, forKey: .programs) ?? []
    }

    static func == (lhs: Channel, rhs: Channel) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

struct Program: Decodable, Hashable {
    let title: String?
    let description: String?
    let start: String?
    let stop: String?

    enum CodingKeys: String, CodingKey {
        case title, start, stop
        case description = "desc"
    }
}

private extension KeyedDecodingContainer {
    func flexibleString(forKey key: Key) -> String? {
        if let value = try? decode(String.self, forKey: key) { return value }
        if let value = try? decode(Int.self, forKey: key) { return String(value) }
        if let value = try? decode(Double.self, forKey: key) { return String(value) }
        return nil
    }
}

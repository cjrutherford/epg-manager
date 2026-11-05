import SwiftUI

struct ChannelGridView: View {
    @EnvironmentObject private var store: GuideStore
    @Binding var selected: Channel?

    private let columns = [
        GridItem(.adaptive(minimum: 380, maximum: 560), spacing: 32)
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            header

            ScrollView {
                LazyVGrid(columns: columns, spacing: 32) {
                    ForEach(store.channels) { channel in
                        Button {
                            selected = channel
                        } label: {
                            ChannelCard(channel: channel, serverURL: store.serverURL)
                        }
                        .buttonStyle(.card)
                    }
                }
                .padding(.horizontal, 60)
                .padding(.vertical, 24)
            }
        }
        .overlay {
            if store.isLoading {
                ProgressView()
                    .padding(28)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18))
            }
        }
        .alert(
            "Could not load channels",
            isPresented: Binding(
                get: { store.error != nil },
                set: { if !$0 { store.error = nil } }
            )
        ) {
            Button("OK", role: .cancel) { store.error = nil }
        } message: {
            Text(store.error ?? "")
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 24) {
            Text("Channels")
                .font(.system(size: 44, weight: .bold))

            Spacer()

            Button("Refresh") {
                Task { await store.load() }
            }

            Button("Change Server") {
                store.resetServer()
            }
        }
        .padding(.horizontal, 60)
        .padding(.top, 40)
    }
}

struct ChannelCard: View {
    let channel: Channel
    let serverURL: String

    private var logoURL: URL? {
        guard let logo = channel.logo, !logo.isEmpty else { return nil }
        if let absolute = URL(string: logo), absolute.scheme != nil {
            return absolute
        }
        let base = serverURL.hasSuffix("/") ? serverURL : serverURL + "/"
        return URL(string: logo, relativeTo: URL(string: base))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 16) {
                AsyncImage(url: logoURL) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .scaledToFit()
                    default:
                        Image(systemName: "tv")
                            .font(.system(size: 38, weight: .thin))
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(width: 128, height: 76)

                Spacer()

                if let number = channel.channelNumber, !number.isEmpty {
                    Text(number)
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
            }

            Text(channel.name)
                .font(.system(size: 28, weight: .semibold))
                .lineLimit(2)
                .multilineTextAlignment(.leading)

            if let title = channel.currentProgram?.title, !title.isEmpty {
                Text(title)
                    .font(.system(size: 20))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            } else if let group = channel.groupTitle, !group.isEmpty {
                Text(group)
                    .font(.system(size: 20))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, minHeight: 180, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 20)
                .fill(Color.white.opacity(0.06))
        )
    }
}

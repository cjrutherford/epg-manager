import SwiftUI

struct ServerSetupView: View {
    @EnvironmentObject private var store: GuideStore
    @State private var address = ""
    @FocusState private var addressFocused: Bool

    var body: some View {
        VStack(spacing: 28) {
            Image(systemName: "tv")
                .font(.system(size: 72, weight: .thin))
                .foregroundStyle(.secondary)

            Text("Tuner Daemon")
                .font(.system(size: 60, weight: .bold))

            Text("Enter the address of your Tuner Daemon server.")
                .font(.system(size: 26))
                .foregroundStyle(.secondary)

            TextField(GuideStore.defaultServer, text: $address)
                .font(.system(size: 28))
                .textFieldStyle(.plain)
                .padding(22)
                .frame(maxWidth: 1000)
                .background(
                    RoundedRectangle(cornerRadius: 14)
                        .fill(Color.white.opacity(0.08))
                )
                .focused($addressFocused)
                .onSubmit {
                    Task { await store.connect(to: address) }
                }

            HStack(spacing: 28) {
                Button("Connect") {
                    Task { await store.connect(to: address) }
                }

                Button("Use default") {
                    address = GuideStore.defaultServer
                    Task { await store.connect(to: address) }
                }
            }

            if store.isLoading {
                ProgressView("Connecting…")
                    .font(.system(size: 22))
            }

            if let error = store.error, !error.isEmpty {
                Text(error)
                    .font(.system(size: 22))
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 1000)
            }
        }
        .padding(80)
        .onAppear {
            if address.isEmpty {
                address = store.serverURL
            }
        }
    }
}

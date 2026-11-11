import AVFoundation
import SwiftUI

/// Liveskärmen: QR-kod att skanna med telefonen, rumskod att slå in för hand,
/// status från servern och stoppknapp.
struct LiveView: View {
  let session: TolkSession

  @State private var streamer = MicStreamer()
  @State private var status = "Ansluter…"
  @State private var listeners: Int?
  @State private var live = false
  @State private var appError: String?
  @State private var captionText: String?

  var body: some View {
    ScrollView {
      VStack(spacing: 6) {
        statusRow

        if live {
          if let ui = session.qrImage {
            // Vit bakgrund ger skannbar kontrast på den mörka klockskärmen.
            Image(uiImage: ui)
              .interpolation(.none)
              .resizable()
              .scaledToFit()
              .padding(6)
              .background(.white, in: RoundedRectangle(cornerRadius: 8))
              .frame(maxWidth: .infinity)
          }
          Text(session.id)
            .font(.system(.title3, design: .monospaced).weight(.bold))
        }

        if let captionText, !captionText.isEmpty {
          Text(captionText)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
        }

        Button(role: .destructive) {
          stop()
        } label: {
          Label("Stoppa", systemImage: "stop.fill")
        }
        .tint(.red)

        if let appError {
          Text(appError).font(.caption2).foregroundStyle(.red)
        }
      }
    }
    .onAppear { startStreaming() }
    .onDisappear { stop() }
  }

  private var statusRow: some View {
    HStack(spacing: 4) {
      Circle()
        .fill(live ? Color.green : Color.orange)
        .frame(width: 8, height: 8)
      Text(status).font(.caption2)
      if let listeners, listeners > 0 {
        Spacer()
        Image(systemName: "person.2.fill").font(.caption2)
        Text("\(listeners)").font(.caption2)
      }
    }
  }

  private func startStreaming() {
    streamer.onPhase = { phase in
      switch phase {
      case .idle: break
      case .micPermission: status = "Ber om mikrofon…"
      case .engineStarting: status = "Startar mikrofon…"
      case .streaming:
        live = true
        status = "Sänder ✓"
      case .failed(let msg):
        appError = msg
        live = false
        status = "Stoppad"
      }
    }
    // Servern skickar partial/final till broadcast-WS:n – visa senaste raden
    // så kan presentatören verifiera att kedjan lever utan öppna telefonen.
    streamer.onCaption = { text in
      captionText = text
    }
    streamer.start(wsURL: TolkAPI.broadcastURL(id: session.id))
  }

  private func stop() {
    streamer.stop()
    live = false
    status = "Stoppad av dig"
  }
}

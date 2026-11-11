import AVFoundation
import SwiftUI

/// Liveskärmen: QR-kod att skanna med telefonen, rumskod att slå in för hand,
/// status från servern och stoppknapp. När sändningen stannat (av dig eller
/// av ett fel) visas "Färdig" som återgår till startskärmen.
struct LiveView: View {
  let session: TolkSession
  /// Anropas när sändningen är avslutad och UI:t ska återgå till startskärmen.
  var onDone: (() -> Void)?

  @State private var streamer = MicStreamer()
  @State private var status = "Ansluter…"
  @State private var listeners: Int?
  @State private var live = false
  @State private var ended = false
  @State private var appError: String?
  @State private var captionText: String?
  @State private var phase = MicStreamer.Phase.idle

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

        if ended {
          Button {
            onDone?()
          } label: {
            Label("Färdig", systemImage: "checkmark")
          }
          .tint(.blue)
        } else {
          Button(role: .destructive) {
            stop()
          } label: {
            Label("Stoppa", systemImage: "stop.fill")
          }
          .tint(.red)
        }

        if let appError {
          Text(appError).font(.caption2).foregroundStyle(.red)
        }
      }
    }
    .onAppear { startStreaming() }
    .onDisappear { streamer.stop() }
  }

  private var statusRow: some View {
    HStack(spacing: 4) {
      Circle()
        .fill(statusColor)
        .frame(width: 8, height: 8)
      Text(status).font(.caption2)
      if let listeners, listeners > 0 {
        Spacer()
        Image(systemName: "person.2.fill").font(.caption2)
        Text("\(listeners)").font(.caption2)
      }
    }
  }

  private var statusColor: Color {
    switch phase {
    case .streaming: return .green
    case .reconnecting: return .orange
    case .failed: return .red
    default: return ended ? .red : .orange
    }
  }

  private func startStreaming() {
    streamer.onPhase = { newPhase in
      phase = newPhase
      switch newPhase {
      case .idle: break
      case .micPermission: status = "Ber om mikrofon…"
      case .engineStarting: status = "Startar mikrofon…"
      case .streaming:
        live = true
        status = "Sänder ✓"
      case .reconnecting:
        status = "Återansluter…"
      case .failed(let msg):
        appError = msg
        endSession()
      }
    }
    // Servern skickar partial/final till broadcast-WS:n – visa senaste raden
    // så presentatören ser att kedjan lever utan öppnad telefon.
    streamer.onCaption = { text in
      captionText = text
    }
    streamer.onListeners = { count in
      listeners = count
    }
    streamer.start(wsURL: TolkAPI.broadcastURL(id: session.id))
  }

  private func stop() {
    streamer.stop()
    endSession()
    status = "Stoppad av dig"
  }

  private func endSession() {
    live = false
    ended = true
  }
}

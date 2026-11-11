import SwiftUI

/// Startskärm: välj källspråk och starta en sändning.
struct StartView: View {
  @State private var sourceLang = TolkConfig.defaultSourceLang
  @State private var starting = false
  @State private var error: String?
  @State private var session: TolkSession?

  private let languages: [(code: String, name: String)] = [
    ("sv", "Svenska"), ("en", "English"), ("de", "Deutsch"),
    ("no", "Norsk"), ("da", "Dansk"), ("fi", "Suomi"),
  ]

  var body: some View {
    VStack(spacing: 8) {
      if let current = session {
        LiveView(session: current) {
          self.session = nil   // "Färdig" – tillbaka till startskärmen/pickern
        }
      } else {
        Picker("Källspråk", selection: $sourceLang) {
          ForEach(languages, id: \.code) { lang in
            Text(lang.name).tag(lang.code)
          }
        }
        Button {
          start()
        } label: {
          Label("Starta textning", systemImage: "mic.fill")
        }
        .tint(.green)
        .disabled(starting)

        if starting { ProgressView("Skapar sändning…") }
        if let error {
          Text(error).font(.caption2).foregroundStyle(.red)
        }
      }
    }
    .navigationTitle("Tolk")
  }

  private func start() {
    starting = true
    error = nil
    Task {
      do {
        let s = try await TolkAPI.createSession(sourceLang: sourceLang)
        session = s
      } catch {
        self.error = error.localizedDescription
      }
      starting = false
    }
  }
}

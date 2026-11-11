// MARK: - Konfig

import Foundation

/// Tjänsten som appen pratar med. Byt till localhost vid utveckling.
enum TolkConfig {
  static let baseURL = URL(string: "https://tolk.berget.ai")!
  /// Chunkstorlek till servern: ~200 ms PCM à 24 kHz.
  static let chunkFrames = 4800
  /// Källspråk som menyn defaultar till.
  static let defaultSourceLang = "sv"
}

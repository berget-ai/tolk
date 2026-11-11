import Foundation
import UIKit

// MARK: - API-modeller (speglar serverns /api/sessions)

struct TolkSession: Decodable {
  let id: String
  let sourceLang: String
  let listenUrl: String
  let qrDataUrl: String

  /// PNG-byten för QR-koden ("data:image/png;base64,…").
  var qrPNGData: Data? {
    guard let comma = qrDataUrl.split(separator: ",", omittingEmptySubsequences: false).last,
          comma.count > 17 else { return nil }
    return Data(base64Encoded: String(comma))
  }

  var qrImage: UIImage? {
    qrPNGData.flatMap(UIImage.init(data:))
  }
}

enum TolkError: LocalizedError {
  case badStatus(Int)
  case badResponse
  case audioSetup(String)
  case serverDown

  var errorDescription: String? {
    switch self {
    case .badStatus(let code): return "Servern svarade \(code)"
    case .badResponse: return "Oväntat svar från servern"
    case .audioSetup(let detail): return "Kan inte använda mikrofonen (\(detail))"
    case .serverDown: return "Kan inte nå \(TolkConfig.baseURL.host ?? "servern")"
    }
  }
}

// MARK: - API-klient

enum TolkAPI {
  /// Skapar en sändning och får tillbaka rumskod + lyssnar-URL + QR-bild.
  static func createSession(sourceLang: String) async throws -> TolkSession {
    var req = URLRequest(url: TolkConfig.baseURL.appendingPathComponent("api/sessions"))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "content-type")
    req.httpBody = try JSONSerialization.data(withJSONObject: ["sourceLang": sourceLang])
    req.timeoutInterval = 15

    let (data, res) = try await URLSession.shared.data(for: req)
    guard let http = res as? HTTPURLResponse else { throw TolkError.badResponse }
    guard http.statusCode == 201 else { throw TolkError.badStatus(http.statusCode) }
    return try JSONDecoder().decode(TolkSession.self, from: data)
  }

  /// Broadcast-WebSocket för rumskoden (/ws/broadcast?id=…).
  static func broadcastURL(id: String) -> URL {
    var parts = URLComponents(url: TolkConfig.baseURL, resolvingAgainstBaseURL: false)!
    parts.scheme = "wss"
    parts.path = "/ws/broadcast"
    parts.queryItems = [URLQueryItem(name: "id", value: id)]
    return parts.url!
  }
}

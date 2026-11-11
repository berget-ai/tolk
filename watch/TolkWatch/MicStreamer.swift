import AVFoundation
import Foundation

/// Läser mikrofonen kontinuerligt och strömmar 24 kHz mono 16-bit PCM i
/// base64-JSON till servern — samma protokoll som webbläsarens AudioWorklet
/// (public/pcm-worklet.js → /ws/broadcast).
final class MicStreamer: ObservableObject {
  enum Phase: Equatable {
    case idle
    case micPermission
    case engineStarting
    case streaming
    case failed(String)
  }

  @Published private(set) var phase: Phase = .idle {
    didSet { onPhase?(phase) }
  }

  /// Vidarebefordrar fasändringar till UI:t (setts av SessionModel).
  var onPhase: ((Phase) -> Void)?

  /// Senaste caption-raden (partial/final) från servern – för en liten
  /// förhandsvisning på klockan.
  var onCaption: ((String) -> Void)?

  private let engine = AVAudioEngine()
  private let queue = DispatchQueue(label: "ai.berget.tolk.mic")
  private lazy var session = URLSession(configuration: .default)

  private var task: URLSessionWebSocketTask?
  private var converter: AVAudioConverter?
  private var targetFormat: AVAudioFormat?
  private var nativeRate: Double = 0
  private var pending = Data()   // int16-samplets little-endian, okickade
  private var pendingFrames = 0
  private var running = false

  func start(wsURL: URL) {
    running = true
    phase = .micPermission
    requestMicPermission { [weak self] granted in
      guard let self else { return }
      guard granted else {
        self.phase = .failed("Mikrofonbehörighet nekades – aktivera i Inställningar.")
        return
      }
      self.phase = .engineStarting
      do {
        try self.configureSession()
        try self.startEngine(wsURL: wsURL)
        self.phase = .streaming
      } catch {
        self.phase = .failed("Mikrofonfel: \(error.localizedDescription)")
      }
    }
  }

  func stop() {
    running = false
    queue.async { [weak self] in
      guard let self else { return }
      self.engine.inputNode.removeTap(onBus: 0)
      self.engine.stop()
      self.task?.cancel(with: .normalClosure, reason: nil)
      self.task = nil
      self.pending = Data()
      self.pendingFrames = 0
    }
    phase = .idle
  }

  // ---- Behörighet -----------------------------------------------------------

  private func requestMicPermission(_ done: @escaping (Bool) -> Void) {
    if #available(watchOS 10.0, *) {
      AVAudioApplication.requestRecordPermission { granted in done(granted) }
    } else {
      AVAudioSession.sharedInstance().requestRecordPermission { granted in done(granted) }
    }
  }

  /// watchOS vill ha kategorin .record innan inputNode:n matas.
  private func configureSession() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.record, mode: .measurement)
    try session.setActive(true)
  }

  // ---- Motor + tap ----------------------------------------------------------

  private func startEngine(wsURL: URL) throws {
    let input = engine.inputNode
    let native = input.outputFormat(forBus: 0)
    guard native.sampleRate > 0 else { throw TolkError.badResponse }
    guard let target = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: Self.targetRate,
      channels: 1,
      interleaved: false
    ), let conv = AVAudioConverter(from: native, to: target) else {
      throw TolkError.badResponse
    }
    targetFormat = target
    converter = conv
    nativeRate = native.sampleRate

    let ws = session.webSocketTask(with: wsURL)
    task = ws
    receiveState()
    ws.resume()

    try engine.start()
    input.installTap(onBus: 0, bufferSize: 4096, format: native) { [weak self] buffer, _ in
      self?.queue.async { self?.convertAndSend(buffer: buffer) }
    }
  }

  // ---- Konvertering till 24 kHz int16 + sändning ---------------------------

  private static let targetRate: Double = 24_000

  private func convertAndSend(buffer: AVAudioPCMBuffer) {
    guard running, let targetFormat, let converter else { return }

    let ratio = Self.targetRate / nativeRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }
    var fed = false
    var error: NSError?
    let status = converter.convert(to: out, error: &error) { _, outStatus in
      if fed { outStatus.pointee = .noDataNow; return nil }
      fed = true
      outStatus.pointee = .haveData
      return buffer
    }
    guard error == nil, status != .error, out.frameLength > 0 else { return }

    // float32 [-1, 1] → int16 little-endian (servern läser readInt16LE).
    let samples = out.floatChannelData![0]
    for i in 0..<Int(out.frameLength) {
      let clamped = max(-1, min(1, samples[i]))
      var value = Int16(clamping: Int(clamped * 32767))
      withUnsafeBytes(of: &value) { pending.append(contentsOf: $0) }
      pendingFrames += 1
    }

    if pendingFrames >= TolkConfig.chunkFrames, let task { sendChunk(task: task) }
  }

  /// ~200 ms ljud per meddelande, som {type:"audio", audio:<base64>} URL-nedan.
  private func sendChunk(task: URLSessionWebSocketTask) {
    let chunk = pending
    pending = Data()
    pendingFrames = 0
    let json = ["type": "audio", "audio": chunk.base64EncodedString()]
    guard JSONSerialization.isValidJSONObject(json),
          let data = try? JSONSerialization.data(withJSONObject: json),
          let text = String(data: data, encoding: .utf8) else { return }
    task.send(.string(text)) { [weak self] err in
      if err != nil { self?.phase = .failed("Sändningen tappades – stoppa och starta igen.") }
    }
  }

  // ---- Serverns state-meddelanden (idle/connecting/ready/error) ------------

  private func receiveState() {
    task?.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .failure(let err):
        if self.running { self.phase = .failed("Anslutningen tappades: \(err.localizedDescription)") }
      case .success(let msg):
        if case .string(let text) = msg,
           let data = text.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
          switch obj["type"] as? String {
          case "state":
            if let state = obj["state"] as? String {
              switch state {
              case "error":
                self.phase = .failed(obj["error"] as? String ?? "Transkriberingsfel")
                self.engine.inputNode.removeTap(onBus: 0)
                self.engine.stop()
              default:
                if self.phase != .streaming { self.phase = .streaming }
              }
            }
          case "partial":
            if let text = obj["text"] as? String { self.onCaption?(text) }
          case "final":
            if let text = obj["text"] as? String { self.onCaption?(text) }
          default:
            break
          }
        }
        if self.running { self.receiveState() }
      }
    }
  }
}

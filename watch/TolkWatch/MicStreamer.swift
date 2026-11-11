import AVFoundation
import Foundation

/// Läser mikrofonen kontinuerligt och strömmar 24 kHz mono 16-bit PCM i
/// base64-JSON till servern — samma protokoll som webbläsarens AudioWorklet
/// (public/pcm-worklet.js → /ws/broadcast).
///
/// Trådmodell: ljudkonverteringen körs på `queue`; allt som rör WS-svaren,
/// fasändringar och callbacks körs på main (UI kan fritt läsa fasen).
final class MicStreamer: ObservableObject {
  enum Phase: Equatable {
    case idle
    case micPermission
    case engineStarting
    case streaming
    /// WS:n tappades – appen återansluter i bakgrunden till samma kod.
    case reconnecting
    case failed(String)
  }

  var onPhase: ((Phase) -> Void)?
  /// Senaste caption-raden (partial/final) från servern.
  var onCaption: ((String) -> Void)?
  /// Antal lyssnare ur serverns state-meddelanden.
  var onListeners: ((Int) -> Void)?

  /// Fas ägs på main – läs den bara från main (UI och callbacks).
  var phase: Phase = .idle

  private let engine = AVAudioEngine()
  private let queue = DispatchQueue(label: "ai.berget.tolk.mic")
  private let session = URLSession(configuration: .default)

  private var wsURL: URL?
  private var task: URLSessionWebSocketTask?
  private var converter: AVAudioConverter?
  private var targetFormat: AVAudioFormat?
  private var nativeRate: Double = 0
  private var pending = Data()   // int16-samplar little-endian, okickade
  private var pendingFrames = 0
  /// Faktiskt sändande pågår. Bara läs/skriv från main; ljudkön läser den
  /// best-effort (en missad runda skippar bara ~200 ms ljud).
  private var running = false

  // ---- Livscykel ------------------------------------------------------------

  func start(wsURL url: URL) {
    wsURL = url
    running = true
    setPhase(.micPermission)
    requestMicPermission { [weak self] granted in
      guard let self, self.running else { return }
      guard granted else {
        self.setPhase(.failed("Mikrofonbehörighet nekades – aktivera i Inställningar."))
        return
      }
      self.setPhase(.engineStarting)
      do {
        try self.configureAudioSession()
        try self.startEngine()
        self.setPhase(.streaming)
      } catch {
        self.setPhase(.failed("Mikrofonfel: \(error.localizedDescription)"))
      }
    }
  }

  func stop() {
    running = false
    queue.sync {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
      pending = Data()
      pendingFrames = 0
    }
    task?.cancel(with: .normalClosure, reason: nil)
    task = nil
    setPhase(.idle)
  }

  private func setPhase(_ newPhase: Phase) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.phase = newPhase
      self.onPhase?(newPhase)
    }
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
  private func configureAudioSession() throws {
    let audioSession = AVAudioSession.sharedInstance()
    try audioSession.setCategory(.record, mode: .measurement)
    try audioSession.setActive(true)
  }

  // ---- Motor + tap ----------------------------------------------------------

  private func startEngine() throws {
    guard let wsURL else { return }
    let input = engine.inputNode
    let native = input.outputFormat(forBus: 0)
    guard native.sampleRate > 0 else {
      throw TolkError.audioSetup("mikrofonformatet saknas")
    }
    guard let target = AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: Self.targetRate,
      channels: 1,
      interleaved: false
    ), let conv = AVAudioConverter(from: native, to: target) else {
      throw TolkError.audioSetup("24 kHz-konverteraren kunde inte byggas")
    }
    targetFormat = target
    converter = conv
    nativeRate = native.sampleRate

    let ws = session.webSocketTask(with: wsURL)
    task = ws
    ws.resume()
    receiveState()

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

  /// ~200 ms ljud per meddelande, som {type:"audio", audio:<base64>}.
  /// Körs på ljudkön; completionen kan landa efter stop() – där är tappade
  /// sändningar förväntade och får inte visa fel.
  private func sendChunk(task: URLSessionWebSocketTask) {
    let payload = pending
    pending = Data()
    pendingFrames = 0
    let json = ["type": "audio", "audio": payload.base64EncodedString()]
    guard JSONSerialization.isValidJSONObject(json),
          let data = try? JSONSerialization.data(withJSONObject: json),
          let text = String(data: data, encoding: .utf8) else { return }
    task.send(.string(text)) { [weak self] err in
      guard let self, self.running, err != nil else { return }
      // Servern kan ha startat om – återanslut, koden lever kvar (lazy-claim).
      self.scheduleReconnect()
    }
  }

  // ---- Servermeddelanden + återanslutning ----------------------------------

  private func receiveState() {
    task?.receive { [weak self] result in
      guard let self = self else { return }
      DispatchQueue.main.async {
        guard self.running else { return }
        self.handleReceive(result)
      }
    }
  }

  /// På main.
  private func handleReceive(_ result: Result<URLSessionWebSocketTask.Message, Error>) {
    switch result {
    case .failure:
      // WS:n dog (serveromstart, nätbyte). Återanvänd koden: lazy-claim återskapar.
      scheduleReconnect()
    case .success(let msg):
      guard case .string(let text) = msg,
            let data = text.data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        receiveState()   // oväntat format – hoppa över och vänta på nästa
        return
      }
      handleServerMessage(obj)
      if running { receiveState() }
    }
  }

  /// På main.
  private func handleServerMessage(_ obj: [String: Any]) {
    switch obj["type"] as? String {
    case "state":
      if let state = obj["state"] as? String {
        switch state {
        case "error":
          stopAudioFacilities()
          setPhase(.failed(obj["error"] as? String ?? "Transkriberingsfel"))
        default:
          if case .failed = phase { break }   // fel är sticky – inte slås tillbaka till streaming av senare state-meddelanden
          if phase != .streaming { setPhase(.streaming) }
        }
      }
      if let listeners = obj["listeners"] as? Int { onListeners?(listeners) }
    case "partial", "final":
      if let text = obj["text"] as? String { onCaption?(text) }
    case "error":
      // T.ex. "The stream is busy" när en annan sändare äger rummet.
      setPhase(.failed(obj["message"] as? String ?? "Avvisad av servern"))
    default:
      break
    }
  }

  private func stopAudioFacilities() {
    queue.async { [weak self] in
      self?.engine.inputNode.removeTap(onBus: 0)
      self?.engine.stop()
    }
  }

  /// Förbinder på nytt med SAMMA rumskod: servern återskapar sessionen
  /// automatiskt (claimSession) så sändningen överlever omstarter.
  private func scheduleReconnect() {
    guard running else { return }
    setPhase(.reconnecting)
    task?.cancel(with: .goingAway, reason: nil)
    task = nil
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
      guard let self, self.running, self.wsURL != nil else { return }
      do {
        try self.startEngine()
        self.setPhase(.streaming)
      } catch {
        self.setPhase(.failed("Kunde inte återansluta: \(error.localizedDescription)"))
      }
    }
  }
}

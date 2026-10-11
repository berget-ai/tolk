// Barnprocess för speaker-diarization via sherpa-onnx (WASM).
// Kör i egen process eftersom WASM-motorn blockerar eventloopen (~4–7 s per fönster).
// Protokoll: JSON per rad på stdin/stdout.
//   in : {"id":1,"pcm24k":"<base64 int16 24kHz>"}
//   ut : {"id":1,"segments":[{"start":0.0,"end":2.1,"speaker":0}]}
const sherpa_onnx = require('sherpa-onnx');
const fs = require('fs');

const SEG_MODEL = './models/sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx';
const EMB_MODEL = './models/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx';

if (!fs.existsSync(SEG_MODEL) || !fs.existsSync(EMB_MODEL)) {
  console.error('[diarizer-child] modeller saknas – kör nedladdningen i README');
  process.exit(2);
}

console.error(`[diarizer-child] startad, clustering threshold 0.4`);
const sd = sherpa_onnx.createOfflineSpeakerDiarization({
  segmentation: { pyannote: { model: SEG_MODEL } },
  embedding: { model: EMB_MODEL },
  // Lite lägre tröskel = delar hellre upp än slår ihop (vid tveksamhet har
  // "fel talare"-missen större synlig effekt än ett spöklikt extrabyte).
  clustering: { numClusters: -1, threshold: 0.4 },
  minDurationOn: 0.2,
  minDurationOff: 0.5,
});

/** 24 kHz int16 → 16 kHz float32 [-1, 1] med linjär interpolering. */
function toF32_16k(pcm) {
  const n24 = (pcm.length / 2) | 0;
  const x = new Float32Array(n24);
  for (let i = 0; i < n24; i++) x[i] = pcm.readInt16LE(i * 2) / 32768;
  const ratio = 24000 / 16000; // 1,5
  const n16 = Math.floor(n24 / ratio);
  const out = new Float32Array(n16);
  for (let i = 0; i < n16; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const frac = pos - j;
    const a = x[j];
    const b = j + 1 < n24 ? x[j + 1] : a;
    out[i] = a * (1 - frac) + b * frac;
  }
  return out;
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    try {
      const pcm = Buffer.from(req.pcm24k, 'base64');
      const samples = toF32_16k(pcm);
      const segments = sd.process(samples);
      process.stdout.write(JSON.stringify({ id: req.id, segments }) + '\n');
    } catch (err) {
      process.stdout.write(JSON.stringify({ id: req.id, error: String(err) }) + '\n');
    }
  }
});

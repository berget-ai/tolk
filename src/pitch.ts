/**
 * Enkel pitch-estimering (grundfrekvens, F0) för 24 kHz mono 16-bit PCM.
 * Autokorrelation över fördröjningar som motsvarar 50–400 Hz, per ljudchunk.
 * Används för att gissa talarbyte: ett nytt röstläge efter en paus är en
 * stark akustisk signal där ren text är för svag (mätt med berget/bev).
 */

const SAMPLE_RATE = 24000;
const MIN_LAG = Math.round(SAMPLE_RATE / 400); // 400 Hz
const MAX_LAG = Math.round(SAMPLE_RATE / 50); // 50 Hz
const VOICED_CLARITY = 0.35; // autokorrelations-topp som krävs för "stämt" ljud

export interface PitchPoint {
  f0: number;
  at: number; // Date.now()
}

/**
 * Uppskattar F0 (Hz) för en PCM-chunk, eller null om chunken är ostämt
 * (sibilant, brus, tystnad). Kostsamheten är liten: ~2048 sampel × 420
 * fördröjningar per chunk.
 */
export function estimatePitch(pcm: Buffer): number | null {
  const n = (pcm.length / 2) | 0;
  if (n < MAX_LAG * 2) return null;

  // Läs till float-array en gång (kroniskt billigare än readInt16LE i loopen)
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = pcm.readInt16LE(i * 2) / 32768;

  let bestLag = 0;
  let bestR = 0;
  for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
    let num = 0, d1 = 0, d2 = 0;
    const m = n - lag;
    for (let i = 0; i < m; i++) {
      const a = x[i], b = x[i + lag];
      num += a * b;
      d1 += a * a;
      d2 += b * b;
    }
    const r = d1 > 0 && d2 > 0 ? num / Math.sqrt(d1 * d2) : 0;
    if (r > bestR) {
      bestR = r;
      bestLag = lag;
    }
  }
  if (bestR < VOICED_CLARITY || bestLag === 0) return null;
  return SAMPLE_RATE / bestLag;
}

/** Median av F0-punkter inom ett tidsfönster (ms tidsstämplar). */
export function medianF0(points: PitchPoint[], fromMs: number, toMs: number): number | null {
  const vals = points.filter((p) => p.at >= fromMs && p.at < toMs).map((p) => p.f0);
  if (vals.length < 3) return null; // för lite data – avstå hellre än att gissa
  vals.sort((a, b) => a - b);
  const mid = vals.length >> 1;
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

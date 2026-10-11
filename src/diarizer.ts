import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';

export interface DiarSegment {
  start: number;
  end: number;
  speaker: number;
}

const SEG_MODEL = 'models/sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx';
const EMB_MODEL = 'models/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx';
const REQUEST_TIMEOUT_MS = 25_000;

/**
 * Hanterar en persistent barnprocess som kör sherpa-onnx-diarization.
 * Anropen serialiseras (modellerna laddas en gång per process).
 * Är modellerna inte nedladdade är `enabled` false och allt faller tillbaka.
 */
class Diarizer {
  readonly enabled: boolean;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private queue: Array<() => void> = [];
  private busy = false;
  private pending = new Map<number, { resolve: (s: DiarSegment[]) => void; timer: NodeJS.Timeout }>();
  private stdoutBuf = '';

  constructor() {
    this.enabled = existsSync(SEG_MODEL) && existsSync(EMB_MODEL);
  }

  private ensureChild(): ChildProcess {
    if (this.child && !this.child.killed) return this.child;

    this.child = spawn(process.execPath, ['src/diarizer-child.cjs'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.stdoutBuf = '';

    this.child.stdout!.on('data', (chunk: Buffer) => {
      this.stdoutBuf += chunk.toString();
      let idx;
      while ((idx = this.stdoutBuf.indexOf('\n')) !== -1) {
        const line = this.stdoutBuf.slice(0, idx);
        this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            clearTimeout(entry.timer);
            entry.resolve(msg.error ? [] : (msg.segments as DiarSegment[]));
          }
        } catch {
          /* trasig rad – ignorera */
        }
        // Klart med ett anrop → starta nästa i kön
        this.busy = false;
        this.kick();
      }
    });

    this.child.on('exit', (code) => {
      console.error(`[diarizer] barnprocessen dog (${code}) – startar om vid behov`);
      this.child = null;
      for (const [, e] of this.pending) {
        clearTimeout(e.timer);
        e.resolve([]);
      }
      this.pending.clear();
      this.busy = false;
    });

    return this.child;
  }

  private kick(): void {
    if (this.busy || this.queue.length === 0) return;
    this.busy = true;
    const job = this.queue.shift()!;
    job();
  }

  /** Kör diarization på ett ljudfönster (int16 PCM, 24 kHz, base64 sköts internt). */
  processWindow(pcm24k: Buffer): Promise<DiarSegment[]> {
    if (!this.enabled) return Promise.resolve([]);
    return new Promise((resolve) => {
      this.queue.push(() => {
        const id = this.nextId++;
        const timer = setTimeout(() => {
          this.pending.delete(id);
          resolve([]);
          this.busy = false;
          this.kick();
        }, REQUEST_TIMEOUT_MS);
        this.pending.set(id, { resolve, timer });
        const child = this.ensureChild();
        child.stdin!.write(JSON.stringify({ id, pcm24k: pcm24k.toString('base64') }) + '\n');
      });
      this.kick();
    });
  }
}

/** Delad instans för hela servern. */
export const diarizer = new Diarizer();

/**
 * Avgör om talaren byttes kring en paus. Jämför talar-ID:t på det SISTA
 * substansiella segmentet före pausen mot det FÖRSTA substansiella segmentet
 * efter att talet återupptog – punktsampling precis vid pauskanterna är för
 * skör mot klustrings-fladder på korta, svagt accentmärkta repliker.
 */
export function speakerChangedAroundPause(
  segments: DiarSegment[],
  pauseStartSec: number,
  resumeSec: number,
): boolean | null {
  // Substansiellt = minst ~0,85 s tal, annars är embeddingen för brusig.
  // (Tröskel strax under en sekund: segmentgränserna är inte samplesäkra.)
  const sizable = segments.filter((s) => s.end - s.start >= 0.85);
  if (sizable.length === 0) return null;

  const before = [...sizable]
    .filter((s) => s.start <= pauseStartSec + 0.2 || s.end <= pauseStartSec + 0.5)
    .sort((a, b) => b.end - a.end)
    .find((s) => s.end <= pauseStartSec + 0.5);
  const after = sizable
    .filter((s) => s.start >= resumeSec - 0.2)
    .sort((a, b) => a.start - b.start)[0];

  if (!before || !after) return null;
  const changed = before.speaker !== after.speaker;
  console.error(
    `[diarizer] jämförelse: före=[${before.start.toFixed(1)}–${before.end.toFixed(1)} spk${before.speaker}] ` +
      `efter=[${after.start.toFixed(1)}–${after.end.toFixed(1)} spk${after.speaker}] paus=${pauseStartSec.toFixed(1)}/${resumeSec.toFixed(1)} → ${changed ? 'BYTE' : 'samma'}`,
  );
  return changed;
}

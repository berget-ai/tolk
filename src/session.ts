import { randomBytes } from 'node:crypto';

import type WebSocket from 'ws';

import { judgeBreakPoint } from './systemone.js';
import { diarizer, speakerChangedAroundPause } from './diarizer.js';
import { estimatePitch, medianF0, type PitchPoint } from './pitch.js';
import { translate } from './translator.js';
import { cleanSegment } from './cleaner.js';
import { Transcriber } from './transcriber.js';

const HISTORY_LIMIT = 500; // möten via textingest genererar långt fler segment än mic-flödet
const INSIGHTS_LIMIT = 100;
const PARTIAL_THROTTLE_MS = 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const IDLE_TTL_MS = 15 * 60 * 1000;

// Styckebrytning ("mellanrum") vid tystnad:
const SPEECH_PEAK = 500; // PCM-amplitud (av 32768) under vilken ljud räknas som tystnad
const LONG_SILENCE_MS = Number(process.env.BREAK_LONG_SILENCE_MS ?? 2000); // bryt alltid
const MIN_PAUSE_FOR_JUDGEMENT_MS = 600; // kortare än så här frågar vi aldrig System One
const THOUGHT_END_THRESHOLD = 0.5; // bev-sannolikhet som krävs för brytning vid kort paus

// Talarbyte (akustiskt): pitch-jämförelse över pausen
const MIN_PAUSE_SPEAKER_MS = 900; // kortare pauser bedöms inte för talarbyte
const SPEAKER_PITCH_RATIO = Number(process.env.SPEAKER_PITCH_RATIO ?? 1.5);
const PITCH_WINDOW_TAIL_MS = 1800; // slutet av förra segmentet
const PITCH_WINDOW_HEAD_MS = 1500; // början av nya segmentet

interface Segment {
  seq: number;
  original: string;
  translations: Record<string, string>;
  gapBefore: boolean;
  speaker: boolean;
  speakerName?: string; // sätts av textingest (mötesbot) – mic-flödet känner inga namn
}

export type InsightKind = 'agenda' | 'action' | 'decision' | 'note';

interface Insight {
  key: string;
  kind: InsightKind;
  text: string;
  at: number;
}

interface AudioChunk {
  buf: Buffer;
  at: number; // Date.now() när chunken togs emot
  ms: number;
}

export type SessionState = 'idle' | 'connecting' | 'ready' | 'error';

/** Tydliga, otvetydiga tecken (utan 0/O, 1/I/L) – ska gå att säga högt och slå in. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newRoomCode(len = 6): string {
  const bytes = randomBytes(len);
  let code = '';
  for (let i = 0; i < len; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

/**
 * En textsändning: en sändare (talarens ljud) och valfritt antal lyssnare
 * som får live-text översatt till sitt språk.
 */
export class Session {
  readonly id = newRoomCode();
  readonly createdAt = Date.now();
  lastActivity = Date.now();
  state: SessionState = 'idle';
  errorMessage = '';

  private transcriber: Transcriber | null = null;
  private broadcaster: WebSocket | null = null;
  private listeners = new Map<WebSocket, string>();
  private history: Segment[] = [];
  private seq = 0;
  private partial = '';
  private partialTimers = new Map<string, NodeJS.Timeout>();
  // Textingest (mötesbot): senaste talarnamnet för byte-detektering
  private lastSpeakerName: string | undefined;
  // Insikter (agenda/åtgärder/beslut) – upsert på key, replay till nya lyssnare
  private insights: Insight[] = [];
  private insightSeq = 0;

  // Tystnadsmätning (räknas på inkommande PCM-chunkar)
  private silenceMs = 0;
  private lastPauseMs = 0;
  private lastPauseAt = 0;
  // Styckebrytning: seq på det segment som ska inleda nytt stycke (0 = inget beslut)
  private gapStartSeq = 0;
  private gapJudged = false;
  // Talarbyte: pitchhistorik + seq på segmentet som inleds av ny talare
  private pitchPoints: PitchPoint[] = [];
  private speakerSeq = 0;
  private speakerJudgedForSeq = 0;
  // Rullande ljudlogg (~45 s) för diarization-fönster
  private audioLog: AudioChunk[] = [];

  constructor(readonly sourceLang: string) {}

  // ---- Sändare -------------------------------------------------------

  attachBroadcaster(ws: WebSocket): boolean {
    if (this.broadcaster) return false;
    this.broadcaster = ws;
    this.state = 'connecting';
    this.broadcastState();

    this.transcriber = new Transcriber(this.sourceLang);
    this.transcriber.on('ready', () => {
      this.state = 'ready';
      this.touch();
      this.broadcastState();
    });
    this.transcriber.on('delta', (text: string) => this.onPartial(text));
    this.transcriber.on('completed', (t: string) => this.onCompleted(t));
    this.transcriber.on('error', (err: unknown) => {
      console.error(`[${this.id}] transcription error:`, err);
      this.state = 'error';
      this.errorMessage = 'Transcription service error';
      this.broadcastState();
    });
    this.transcriber.connect().catch((err) => {
      console.error(`[${this.id}] could not connect:`, err);
      this.state = 'error';
      this.errorMessage = 'Could not connect to the transcription service';
      this.broadcastState();
    });
    return true;
  }

  detachBroadcaster(ws: WebSocket): void {
    if (this.broadcaster !== ws) return;
    this.broadcaster = null;
    this.transcriber?.close();
    this.transcriber = null;
    this.state = 'idle';
    this.partial = '';
    this.touch();
    this.broadcastState();
  }

  handleAudio(ws: WebSocket, base64: string): void {
    if (ws !== this.broadcaster) return;
    this.touch();
    const buf = Buffer.from(base64, 'base64');
    this.measureSilence(buf);
    // Rullande ljudlogg för diarization (behåll ~45 s)
    this.audioLog.push({ buf, at: Date.now(), ms: (buf.length / 2 / 24000) * 1000 });
    while (this.audioLog.reduce((s, c) => s + c.ms, 0) > 45_000 && this.audioLog.length > 1) {
      this.audioLog.shift();
    }
    this.transcriber?.appendAudio(base64);
  }

  /** Räknar på varje ljudchunk om det är tal eller tystnad just nu. */
  private measureSilence(buf: Buffer): void {
    let peak = 0;
    for (let i = 0; i + 1 < buf.length; i += 16) {
      const s = Math.abs(buf.readInt16LE(i));
      if (s > peak) peak = s;
    }
    const chunkMs = (buf.length / 2 / 24000) * 1000;
    if (peak < SPEECH_PEAK) {
      this.silenceMs += chunkMs;
      // Lång tystnad räcker i sig för mellanrum – besluta direkt medan
      // tystnaden fortfarande pågår.
      if (this.silenceMs >= LONG_SILENCE_MS && this.seq >= 1 && this.gapStartSeq === 0) {
        this.gapStartSeq = this.seq + 1;
        console.log(`[${this.id}] paus ≥ ${LONG_SILENCE_MS} ms → mellanrum före segment ${this.gapStartSeq}`);
      }
    } else {
      if (this.silenceMs >= MIN_PAUSE_FOR_JUDGEMENT_MS) {
        this.lastPauseMs = this.silenceMs;
        this.lastPauseAt = Date.now();
      }
      this.silenceMs = 0;
      // Stämt ljud: spara pitch (grunden till talarbytestekningen)
      const f0 = estimatePitch(buf);
      if (f0 !== null) {
        this.pitchPoints.push({ f0, at: Date.now() });
        if (this.pitchPoints.length > 400) this.pitchPoints.shift(); // ~30 s historik
      }
    }
  }

  /**
   * Mellanrummet avgörs först när talet sätts igång igen (första deltan i ett
   * nytt segment) – då vet vi hur lång tystnaden faktiskt blev. Server-VAD:n
   * committar redan ~700 ms in i tystnaden, så ett beslut vid completed-tidpunkten
   * hade aldrig sett hela pausen.
   */
  private maybeJudgeGap(): void {
    if (this.seq < 1 || this.gapJudged || this.gapStartSeq !== 0) return;
    this.gapJudged = true;
    // Är pausen aktuell? Första deltan för ett nytt segment kan dröja upp mot
    // ~5 s efter att talet återupptog (modellen buffrar), så ge generös marginal
    // innan pausmätningen anses för gammal.
    if (Date.now() - this.lastPauseAt > 12_000) return;
    const pause = this.lastPauseMs;
    if (pause >= LONG_SILENCE_MS) {
      this.gapStartSeq = this.seq + 1;
      return;
    }
    if (pause < MIN_PAUSE_FOR_JUDGEMENT_MS) return;

    // Mellanlång paus: låt System One (bev) bedöma om det är slutet på en tanke.
    const targetSeq = this.seq + 1;
    const context = this.history
      .slice(-3)
      .map((s) => s.original)
      .concat([this.partial])
      .join(' ');
    void judgeBreakPoint(context).then((j) => {
      if (!j) {
        console.log(`[${this.id}] paus ${Math.round(pause)} ms, bev svarade inte → inget mellanrum`);
        return;
      }
      const thought = j.thoughtEnd.toFixed(2);
      if (this.seq + 1 !== targetSeq) {
        // Segmentet hann redan avslutas medan bev funderade – för sent att
        // bryta före det (och meningsfulltvis bryter vi inte i efterhand).
        console.log(`[${this.id}] paus ${Math.round(pause)} ms, bev thought=${thought} → för sent, segment ${targetSeq} passerat`);
        return;
      }
      if (j.thoughtEnd >= THOUGHT_END_THRESHOLD) {
        this.gapStartSeq = targetSeq;
        console.log(`[${this.id}] paus ${Math.round(pause)} ms, bev thought=${thought} → mellanrum`);
      } else {
        console.log(`[${this.id}] paus ${Math.round(pause)} ms, bev thought=${thought} → inga`);
      }
    });
  }

  private gapFor(seq: number): boolean {
    return this.gapStartSeq === seq;
  }

  /**
   * Talarbytestekning vid pauser. Primärt: sherpa-onnx-diarization (pyannote
   * segmentering + 3D-Speaker-embeddings) på ett ljudfönster kring pausen.
   * Fallback om modellerna inte är nedladdade: grov pitch-heuristik.
   */
  private maybeJudgeSpeaker(): void {
    if (this.seq < 1) return;
    const targetSeq = this.seq + 1;
    if (this.speakerJudgedForSeq === targetSeq) return;
    // Första partialen i ett segment kan dröja ~5 s efter att talet återupptog
    // (modellen buffrar) – var generös, lastPauseAt skrivs över vid nästa paus.
    if (Date.now() - this.lastPauseAt > 12_000) return;
    const pause = this.lastPauseMs;
    if (pause < MIN_PAUSE_SPEAKER_MS) return;
    this.speakerJudgedForSeq = targetSeq;

    if (diarizer.enabled) {
      void this.runDiarizationJudgement(targetSeq, pause);
    } else {
      this.judgeSpeakerByPitch(targetSeq, pause);
    }
  }

  /** Bygger ett ljudfönster kring pausen och frågar diarization-barnprocessen. */
  private async runDiarizationJudgement(targetSeq: number, pauseMs: number): Promise<void> {
    const resumeAt = this.lastPauseAt;
    const pauseStart = resumeAt - pauseMs;

    // Se till att det finns minst ~2 s tal efter pausen i fönstret – kortare
    // än så ger embeddingsen för svagt underlag (falskt "samma talare").
    const postAvailable = this.audioLog
      .filter((c) => c.at >= resumeAt)
      .reduce((s, c) => s + c.ms, 0);
    if (postAvailable < 2000) {
      await new Promise((r) => setTimeout(r, 1500));
    }

    const windowStart = pauseStart - 8000;
    const windowEnd = Math.min(resumeAt + 2500, Date.now());
    const parts = this.audioLog.filter((c) => c.at + c.ms > windowStart && c.at <= windowEnd);
    if (parts.reduce((s, c) => s + c.ms, 0) < 3000) {
      console.log(`[${this.id}] diarization: för lite ljud i fönstret → bedöms ej`);
      return;
    }
    const pcm = Buffer.concat(parts.map((c) => c.buf));
    const actualStart = parts[0].at;

    const segments = await diarizer.processWindow(pcm);
    const changed = speakerChangedAroundPause(
      segments,
      (pauseStart - actualStart) / 1000,
      (resumeAt - actualStart) / 1000,
    );
    if (changed === null) {
      console.log(`[${this.id}] paus ${Math.round(pauseMs)} ms, diarization gav inget utslag → samma talare`);
      return;
    }
    if (changed) {
      this.markSpeakerChange(targetSeq, `diarization (${segments.length} segment i fönstret)`);
    } else {
      console.log(`[${this.id}] paus ${Math.round(pauseMs)} ms, diarization → samma talare`);
    }
  }

  /** Registrerar ett talarbyte – oavsett om beslutet landar före eller efter finalen. */
  private markSpeakerChange(seq: number, via: string): void {
    this.speakerSeq = seq;
    this.gapStartSeq ||= seq; // ny talare får alltid nytt stycke
    console.log(`[${this.id}] NY TALARE före segment ${seq} (${via})`);

    const seg = this.history.find((s) => s.seq === seq);
    if (seg) seg.speaker = true;

    // Landade beslutet efter att finalen redan sänds? Skicka retroaktivt event.
    if (this.seq >= seq) {
      const msg = { type: 'speaker', seq };
      this.send(this.broadcaster, msg);
      for (const ws of this.listeners.keys()) this.send(ws, msg);
    }
  }

  /** Fallback: median-pitch före/efter pausen (grovt, men svagt positivt). */
  private judgeSpeakerByPitch(targetSeq: number, pauseMs: number): void {
    const resumeAt = this.lastPauseAt;
    const pauseStart = resumeAt - pauseMs;
    const fBefore = medianF0(
      this.pitchPoints,
      pauseStart - PITCH_WINDOW_TAIL_MS,
      pauseStart - 200,
    );
    const fAfter = medianF0(this.pitchPoints, resumeAt + 100, resumeAt + PITCH_WINDOW_HEAD_MS);
    if (fBefore === null || fAfter === null) {
      console.log(`[${this.id}] paus ${Math.round(pauseMs)} ms, pitch saknas → talarbyte bedöms ej`);
      return;
    }
    const ratio = Math.max(fBefore, fAfter) / Math.min(fBefore, fAfter);
    if (ratio >= SPEAKER_PITCH_RATIO) {
      this.markSpeakerChange(targetSeq, `pitch ×${ratio.toFixed(2)}`);
    } else {
      console.log(
        `[${this.id}] pitch ${Math.round(fBefore)}→${Math.round(fAfter)} Hz (×${ratio.toFixed(2)}) → samma talare`,
      );
    }
  }

  // ---- Lyssnare ------------------------------------------------------

  addListener(ws: WebSocket, lang: string): void {
    this.listeners.set(ws, lang);
    this.touch();
    this.broadcastState();

    // Skicka historik i lyssnarens språk, i ordning – i begränsade batchar,
    // så att en sen anslutning på ett nytt språk inte eldar hundratals
    // samtidiga översättningsanrop mot den betalda API:n. Snapshot: replayen
    // kan pågå länge – segment som committas under tiden når lyssnaren via
    // commitSegments fläkt, och ska varken dubbelsändas eller skjuta undan
    // index i historiken.
    const BACKLOG_CONCURRENCY = 8;
    const backlog = this.history.slice();
    void (async () => {
      for (let i = 0; i < backlog.length; i += BACKLOG_CONCURRENCY) {
        await Promise.all(
          backlog.slice(i, i + BACKLOG_CONCURRENCY).map(async (seg) => {
            const text = await this.translationFor(seg, lang);
            this.send(ws, {
              type: 'final', seq: seg.seq, text,
              gapBefore: seg.gapBefore, speaker: seg.speaker, speakerName: seg.speakerName,
            });
          }),
        );
      }
    })();

    // Insikter översätts inte – de replayas i originals språk (se README).
    for (const i of this.insights) {
      this.send(ws, { type: 'insight', key: i.key, kind: i.kind, text: i.text, at: i.at });
    }

    const current = this.partial;
    if (current) {
      void translate(current, this.sourceLang, lang).then((text) => {
        if (this.partial === current) {
          this.send(ws, { type: 'partial', seq: this.seq + 1, text });
        }
      });
    }
  }

  removeListener(ws: WebSocket): void {
    if (this.listeners.delete(ws)) this.broadcastState();
    this.touch();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  get hasBroadcaster(): boolean {
    return this.broadcaster !== null;
  }

  // ---- Pipeline --------------------------------------------------------

  private onPartial(text: string): void {
    const isNewSegment = this.partial === '';
    this.partial = text;
    this.touch();
    if (isNewSegment) {
      this.maybeJudgeSpeaker();
      this.maybeJudgeGap();
    }
    const nextSeq = this.seq + 1;
    const gapBefore = this.gapFor(nextSeq);
    const speaker = this.speakerSeq === nextSeq;
    this.send(this.broadcaster, { type: 'partial', seq: nextSeq, text, gapBefore, speaker });
    for (const lang of this.distinctLangs()) this.schedulePartial(lang);
  }

  /**
   * Översätter den löpande texten i fast takt (en gång per PARTIAL_THROTTLE_MS
   * per språk). Om texten hunnit ändras under översättningen bokas direkt en
   * ny omgång, så lyssnaren får en jämn ström även under oavbrutet tal.
   */
  private schedulePartial(lang: string): void {
    if (this.partialTimers.has(lang)) return; // en översättning är redan bokad
    const timer = setTimeout(() => {
      this.partialTimers.delete(lang);
      const current = this.partial;
      if (!current) return;
      void translate(current, this.sourceLang, lang).then((translated) => {
        if (this.partial === current) {
          const gapBefore = this.gapFor(this.seq + 1);
          this.sendToLang(lang, { type: 'partial', seq: this.seq + 1, text: translated, gapBefore });
        } else if (this.partial) {
          this.schedulePartial(lang); // texten rörde sig – ta den nya direkt
        }
      });
    }, PARTIAL_THROTTLE_MS);
    this.partialTimers.set(lang, timer);
  }

  private onCompleted(transcript: string): void {
    this.touch();
    this.partial = '';
    for (const timer of this.partialTimers.values()) clearTimeout(timer);
    this.partialTimers.clear();

    // Renskrivningssteget sker i en seriekö: segmenten landar alltid i ordning
    // i historiken även om rensladen avgörs (fai-open lugnar timern).
    const seq = ++this.seq;
    const gap = this.gapFor(seq);
    if (gap) this.gapStartSeq = 0;
    this.gapJudged = false; // nästa segment får en ny bedömning
    this.finalizeChain = this.finalizeChain.then(() => this.finalizeSegment(seq, transcript, gap));
  }

  private finalizeChain: Promise<void> = Promise.resolve();

  /**
   * Mellanrumsbeslutet (gapStartSeq) är redan taget när segmentet började –
   * här konstaterar vi bara om just detta segment inleder ett nytt stycke.
   */
  private async finalizeSegment(seq: number, transcript: string, gap: boolean): Promise<void> {
    const text = await cleanSegment(transcript, this.sourceLang);
    this.commitSegment({
      seq,
      original: text,
      translations: {},
      gapBefore: gap,
      speaker: this.speakerSeq === seq,
    });
  }

  /** Historik + broadcast + översättningsfläkt – delad av ljud- och textingestvägen. */
  private commitSegment(seg: Segment): void {
    this.history.push(seg);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();

    this.send(this.broadcaster, {
      type: 'final', seq: seg.seq, text: seg.original,
      gapBefore: seg.gapBefore, speaker: seg.speaker, speakerName: seg.speakerName,
    });
    for (const lang of this.distinctLangs()) {
      void this.translationFor(seg, lang).then((translated) =>
        this.sendToLang(lang, {
          type: 'final', seq: seg.seq, text: translated,
          gapBefore: seg.gapBefore, speaker: seg.speaker, speakerName: seg.speakerName,
        }),
      );
    }
  }

  // ---- Textingest (extern producent, t.ex. mötesbotten) ------------------

  /**
   * Ett färdigt talartal från extern källa. Hoppar över ljudpipan (VAD,
   * rensning, diarization) men delar historik, seq-rymd och översättnings-
   * fläkt med ljudflödet. Talarnamnet är känt vid ingest, så inga
   * retroaktiva speaker-event behövs – bytet markeras direkt på segmentet.
   */
  ingestTextSegment(text: string, speakerName?: string): void {
    this.touch();
    const seq = ++this.seq;
    const speakerChanged = speakerName !== undefined && speakerName !== this.lastSpeakerName;
    if (speakerName !== undefined) this.lastSpeakerName = speakerName;
    // Samma regel som akustiskt talarbyte: ny talare inleder alltid nytt stycke.
    // Seriekön delas med ljudflödet så segmenten aldrig blandar ordning.
    this.finalizeChain = this.finalizeChain.then(() =>
      this.finalizeIngestedSegment(seq, text, speakerChanged, speakerName),
    );
  }

  private async finalizeIngestedSegment(
    seq: number,
    text: string,
    speakerChanged: boolean,
    speakerName?: string,
  ): Promise<void> {
    this.commitSegment({
      seq,
      original: text,
      translations: {},
      gapBefore: speakerChanged,
      speaker: speakerChanged,
      speakerName,
    });
  }

  /**
   * Lägger till en insikt, eller ersätter befintlig om samma key skickas
   * (rullande uppdateringar från producenten spammar inte panelen).
   * Sänds till alla + sparas för replay till sen anslutna lyssnare.
   */
  upsertInsight(kind: InsightKind, text: string, key?: string): Insight {
    this.touch();
    let insight = key ? this.insights.find((i) => i.key === key) : undefined;
    if (insight) {
      insight.kind = kind;
      insight.text = text;
      insight.at = Date.now();
    } else {
      insight = { key: key ?? `i${++this.insightSeq}`, kind, text, at: Date.now() };
      this.insights.push(insight);
      if (this.insights.length > INSIGHTS_LIMIT) this.insights.shift();
    }
    const msg = { type: 'insight', key: insight.key, kind: insight.kind, text: insight.text, at: insight.at };
    this.send(this.broadcaster, msg);
    for (const ws of this.listeners.keys()) this.send(ws, msg);
    return insight;
  }

  private async translationFor(seg: Segment, lang: string): Promise<string> {
    seg.translations[lang] ??= await translate(seg.original, this.sourceLang, lang);
    return seg.translations[lang];
  }

  // ---- Hjälp ---------------------------------------------------------

  private distinctLangs(): Set<string> {
    return new Set(this.listeners.values());
  }

  private sendToLang(lang: string, msg: object): void {
    for (const [ws, l] of this.listeners) {
      if (l === lang) this.send(ws, msg);
    }
  }

  private broadcastState(): void {
    const msg = {
      type: 'state',
      state: this.state,
      error: this.errorMessage,
      sourceLang: this.sourceLang,
      listeners: this.listenerCount,
    };
    this.send(this.broadcaster, msg);
    for (const ws of this.listeners.keys()) this.send(ws, msg);
  }

  private send(ws: WebSocket | null, msg: object): void {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private touch(): void {
    this.lastActivity = Date.now();
  }

  destroy(): void {
    this.transcriber?.close();
    for (const timer of this.partialTimers.values()) clearTimeout(timer);
    this.broadcaster?.close();
    for (const ws of this.listeners.keys()) ws.close();
  }
}

// ---- Sessionsregister --------------------------------------------------

const sessions = new Map<string, Session>();

export function createSession(sourceLang: string): Session {
  let session = new Session(sourceLang);
  while (sessions.has(session.id)) session = new Session(sourceLang);
  sessions.set(session.id, session);
  return session;
}

/** Slår upp oavsett skiftläge och tolererar mellanslag/streck i inmatningen. */
export function normalizeRoomCode(id: string): string {
  return id.trim().toUpperCase().replace(/[\s-]/g, '');
}

export function getSession(id: string): Session | undefined {
  return sessions.get(normalizeRoomCode(id));
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    const stale =
      now - s.createdAt > SESSION_TTL_MS ||
      (now - s.lastActivity > IDLE_TTL_MS && !s.hasBroadcaster && s.listenerCount === 0);
    if (stale) {
      s.destroy();
      sessions.delete(id);
    }
  }
}, 60 * 1000).unref();

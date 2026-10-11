import EventEmitter from 'node:events';

import OpenAI from 'openai';
import { OpenAIRealtimeWS } from 'openai/realtime/ws';

const SAMPLE_RATE = 24000;

export interface TranscriberEvents {
  /** Löpande text medan någon talar (ackumulerad för aktuellt segment). */
  delta: (fullText: string) => void;
  /** Färdigt segment när talaren gjort en paus. */
  completed: (transcript: string) => void;
  error: (err: unknown) => void;
  ready: () => void;
}

/**
 * En uppkoppling mot Berget AI:s realtime-transkription (OpenAI-kompatibel).
 * Tar emot 24 kHz mono 16-bit PCM som base64 och emitterar text.
 */
export class Transcriber extends EventEmitter {
  private rt: OpenAIRealtimeWS | null = null;
  private partial = '';
  private closed = false;
  private sessionReady = false;
  private prebuffer: string[] = [];

  /** Max ~17 s ljud i förbufferten (à 85 ms) medan uppkopplingen etableras. */
  private static readonly PREBUFFER_MAX = 200;

  constructor(
    private sourceLang: string,
    private model: string = process.env.TRANSCRIBE_MODEL ?? 'klang/pianissimo',
  ) {
    super();
  }

  async connect(): Promise<void> {
    const client = new OpenAI({
      apiKey: process.env.BERGET_API_KEY,
      baseURL: 'https://api.berget.ai/v1',
    });

    this.rt = await OpenAIRealtimeWS.create(client, { model: this.model });

    this.rt.on('error', (err: unknown) => this.emit('error', err));

    this.rt.on('session.created', () => {
      this.rt?.send({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: SAMPLE_RATE },
              transcription: {
                model: this.model,
                languages: [this.sourceLang],
              },
              // Server-VAD: segmentet committas automatiskt vid pauser i talet.
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 700,
              },
            },
          },
        } as never,
      });

      // SDK:n buffrar inte själv – skicka först nu det som hunnit samlas.
      this.sessionReady = true;
      for (const audio of this.prebuffer) {
        this.rt?.send({ type: 'input_audio_buffer.append', audio });
      }
      this.prebuffer = [];
      this.emit('ready');
    });

    this.rt.on(
      'conversation.item.input_audio_transcription.delta',
      (event: { delta?: string }) => {
        this.partial += event.delta ?? '';
        this.emit('delta', this.partial);
      },
    );

    this.rt.on(
      'conversation.item.input_audio_transcription.completed',
      (event: { transcript?: string }) => {
        const transcript = (event.transcript ?? this.partial).trim();
        this.partial = '';
        if (transcript) this.emit('completed', transcript);
      },
    );
  }

  /** Skicka ett ljudblock (24 kHz mono 16-bit PCM, base64). */
  appendAudio(base64: string): void {
    if (this.closed) return;
    if (this.sessionReady && this.rt) {
      try {
        this.rt.send({ type: 'input_audio_buffer.append', audio: base64 });
      } catch {
        /* socketen hann stängas – ignorera */
      }
    } else {
      this.prebuffer.push(base64);
      if (this.prebuffer.length > Transcriber.PREBUFFER_MAX) this.prebuffer.shift();
    }
  }

  close(): void {
    this.closed = true;
    try {
      this.rt?.close();
    } catch {
      /* redan stängd */
    }
    this.rt = null;
  }
}

export { SAMPLE_RATE };

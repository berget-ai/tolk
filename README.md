# Berget Tolk

Live captions for talks, conferences and weddings. The audience scans a QR code
and gets **real-time captions in their own language** on their phone – no app,
no sign-up.

Audio is transcribed in real time by **Klang Pianissimo** (trained for Swedish,
~3,600× real time) via **Berget AI** and translated on the fly with Berget's
chat models. All processing happens in Sweden – neither audio nor transcripts
are stored by Berget AI.

## How it works

No login – the same flow as Mentimeter:

1. **The landing page** offers two paths: *Join a stream* (type the six-character
   room code) or *Start a new stream* (pick the spoken language – done).
2. **Open the presentation screen (`/live?id=CODE`)** – the all-in-one screen for the
   projector: captions like on live TV (large white lines at the bottom,
   older lines faded), QR code and room code pinned in the corner, plus audio
   capture straight from this device with a microphone input selector (external
   mixers/USB sound cards work). A single laptop does the whole job.
   One session accepts a single broadcaster – the first device that connects
   claims it.
3. **The audience** scans the QR code (or types the room code), picks a language
   and reads along live. Partial fragments are translated continuously (max
   once/second per language) and finalized segments replace them. The screen is
   kept awake via Wake Lock.

Microphone audio streams as 24 kHz PCM over WebSocket to the server, which
forwards it to Berget AI's realtime endpoint (`klang/pianissimo`) with server
VAD – speech is segmented automatically at pauses.

The large screen view shows the source language by default (the server skips
the translation step when source and target match). To caption the big screen
in another language: `/live?id=CODE&lang=en`.

### Paragraph breaks at silence ("mellanrum")

When the speaker pauses, a small gap is inserted between caption paragraphs on
all screens. The decision is a hybrid:

- **Long silences (≥ 2 s, `BREAK_LONG_SILENCE_MS`)** always break – the
  server measures real silence directly on the incoming PCM stream.
- **Shorter pauses (0.6–2 s)** are judged by Berget's **System One** decision
  model (`/v1/systemone`, `berget/bev`, ~30 ms): it rates whether the cut is
  mid-sentence, end of sentence or end of thought. Only a confident
  "thought ends" (p ≥ 0.5) breaks.

We use `berget/bev` rather than `laya-latest` because it understands Swedish
much better on this judgement: in probes it separates "stops mid-sentence"
from "a thought ends" with p 0.81–0.93, where Laya sits at noise level
(0.25–0.40). The consideration is still logged per segment
(`pause N ms, bev thought=X → …`) and a failed System One call never blocks
captions; it simply yields no break.

### Speaker changes ("talstreck")

When a new speaker takes over, their first line starts with an em dash (—) and
a fresh caption block – standard subtitling practice. Detection runs fully
on-server at pauses ≥ 900 ms using **sherpa-onnx speaker diarization**:
pyannote segmentation + 3D-Speaker speaker embeddings over an audio window
around the pause (8 s before, ~2.5 s after), in a dedicated child process so
the WASM engine never blocks the event loop. When the diarization models are
not downloaded the feature silently falls back to a coarse pitch heuristic,
and captions never wait on a decision – if the verdict lands after the line
is already shown, a retroactive event marks it in place.

The models are large binaries and not committed:

```bash
mkdir -p models
cd models
curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2
tar xf sherpa-onnx-pyannote-segmentation-3-0.tar.bz2
curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx
```

Attribution: the embedding model
(`3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx`) is trained on
[VoxCeleb](https://www.robots.ox.ac.uk/~vgg/data/voxceleb/) and published by
the sherpa-onnx project under **CC-BY-4.0**. The segmentation model is
pyannote-segmentation-3.0 (MIT) by Hervé Bredin, converted by the sherpa-onnx
project.

## Getting started

```bash
npm install
cp .env.example .env   # fill in BERGET_API_KEY from https://berget.ai
npm start
```

Then open http://localhost:3000.

| Variable | Default | Description |
| --- | --- | --- |
| `BERGET_API_KEY` | – | API key from Berget AI (required) |
| `PORT` | `3000` | Port |
| `PUBLIC_URL` | `http://localhost:PORT` | Public URL encoded in the QR code |
| `TRANSCRIBE_MODEL` | `klang/pianissimo` | Transcription model (trained for Swedish) |
| `TRANSLATE_MODEL` | `google/gemma-4-31B-it` | Translation model |

## Ingest API (external producers, e.g. the meeting bot)

Sessions can also be fed **finished transcript text** instead of microphone
audio – e.g. by [meeting-transcriber](https://github.com/berget-ai/meeting-transcriber),
which pushes per-speaker turns and rolling meeting insights from Matrix calls.

Disabled by default: set `INGEST_API_KEY` to enable the endpoints (use a
dedicated key – **never** `BERGET_API_KEY`, which is a billing key). When
unset, the endpoints answer `404`.

```bash
# A finished speaker turn (speaker is optional, max 4000 chars)
curl -X POST https://tolk.example.com/api/sessions/ABCDEF/segments \
  -H "Authorization: Bearer $INGEST_API_KEY" -H "content-type: application/json" \
  -d '{"speaker": "Magnus", "text": "Vi börjar med budgeten."}'
# → 202 {"ok": true}

# A meeting insight. kind: agenda | action | decision | note (unknown → note).
# Pass a stable "key" to update in place instead of stacking new rows.
curl -X POST https://tolk.example.com/api/sessions/ABCDEF/insights \
  -H "Authorization: Bearer $INGEST_API_KEY" -H "content-type: application/json" \
  -d '{"kind": "action", "text": "Magnus bokar demo på fredag", "key": "a1"}'
# → 202 {"ok": true, "key": "a1"}
```

Semantics:

- Ingested segments share history, sequence space and the translation fan-out
  with the audio pipeline, but skip VAD/cleaning/diarization (the producer has
  already done that job). A change of `speaker` starts a new paragraph and is
  rendered as `Name: ` instead of the acoustic em dash.
- Insights are broadcast to all connected clients and replayed to late
  joiners (ring buffer of 100). They are **not translated** – pushed in the
  meeting's language. The audience page shows them in a collapsible panel
  that appears on the first insight.
- Ingest keeps the session alive (counts as activity for the idle reaper),
  so a meeting session won't be reaped while the bot is pushing.
- Sessions are in-memory: if the server restarts, the producer should
  recreate the session on the next push (a `404` means "session gone").

## Deployment

- Set `PUBLIC_URL` to the HTTPS address the service is reachable at, e.g.
  `https://captions.example.com`, behind a reverse proxy (Caddy/nginx).
- **HTTPS is required on the broadcaster page** – browsers only grant
  microphone access in secure contexts (localhost or https). The audience and
  large screen views need no microphone but should also run over HTTPS.
- WebSocket is used for both broadcasters and listeners; make sure the proxy
  forwards the `Upgrade` headers.

## Architecture

```
microphone → broadcast page (PCM 24k) ──ws──▶ server ──ws (OpenAI realtime)──▶ api.berget.ai klang/pianissimo
                                                │
                                                ├─▶ chat completions (Gemma 4) ─▶ translation
                                                └──ws──▶ listen page on every phone + large screen view
```

| File | Responsibility |
| --- | --- |
| `src/server.ts` | HTTP, static files, WebSocket endpoints, QR generation |
| `src/session.ts` | Session lifecycle, room codes, listener registry, history, throttling |
| `src/transcriber.ts` | Berget realtime connection, audio pre-buffering |
| `src/translator.ts` | Translation via Berget chat completions |
| `public/index.html` | Mentimeter-style flow: join by room code or create a stream |
| `public/live.html` | Large screen view – captions like on live TV, QR pinned, mic → PCM → WebSocket |
| `public/listen.html` | Audience view (language picker, captions, wake lock) |
| `public/theme.css` | Shared theme on `@bergetai/ui` tokens (dark) |
| `public/pcm-worklet.js` | AudioWorklet: resampling to 24 kHz mono 16-bit PCM |

## Limitations / known choices

- `klang/pianissimo` is trained for **Swedish** (dialects and accents included).
  Other source languages need a different transcription model – set
  `TRANSCRIBE_MODEL` and adjust `languages` in `src/transcriber.ts`.
- Partial text is translated at most once per second and language to keep
  latency and cost down; finalized segments are always translated immediately.
- One broadcaster per session. Listeners: unlimited (one WebSocket each).
- The last 500 segments are shown to late joiners, translated into their language.
- Room codes use an unambiguous alphabet (no 0/O, 1/I/L) and are
  case-insensitive when typed by hand.

## Cost estimate

Pianissimo costs €3.50 per 1,000 minutes of audio – an hour-long talk ≈ €0.21.
Translation into five languages for an hour's talk is on the order of a few
cents with Gemma 4 31B.

## License

[AGPL-3.0](LICENSE) (same as Berget AI's other public services). Third-party
attribution for the speaker-diarization models is listed under
[Speaker changes](#speaker-changes-talstreck) above.

Production instance: [tolk.berget.ai](https://tolk.berget.ai) — source:
[github.com/berget-ai/tolk](https://github.com/berget-ai/tolk).

# Tolk för Apple Watch

Watch-app som gör klockan till en **mikrofon och sändare för Tolk**: klockans mikrofon
strömmas till Tolk-servern och QR-koden på skärmen skannas av telefonen (eller
publikens telefoner) för att läsa captions i sitt språk. Ingen iPhone-app
krävs för sändningen – klockan hanterar allt själv.

```
resep-mikrofon → AVAudioConverter (24 kHz mono int16)
   → URLSessionWebSocketTask → wss://tolk.berget.ai/ws/broadcast?id=CODE
        └─ servern (samma pipeline som /live-sidan): klang/pianissimo →
           renskrivning → översättning → captions
```

Protokollet är detsamma som webbläsarens AudioWorklet (`public/pcm-worklet.js`):
base64-kodade `{type: "audio", audio: …}`-meddelanden à ~200 ms. Serverns
`state`-meddelanden (idle/connecting/ready/error) visas som statusrad, och
raden med senaste transkriberade texten visas underst på klockan så
presentatören ser att kedjan lever. **Serveromstart**: WS:n återansluter
automatiskt med samma rumskod varannan sekund – servern återskapar sessionen
på koden (se "Reusable room codes" i huvud-README:n) och sändningen fortsätter.

## Öppna och köra

```bash
cd watch
open TolkWatch.xcodeproj     # Xcode 26+ (xcodebuild -showsdks → watchsimulator)
```

1. Välj din Apple Watch som run-destination (eller en watchOS-simulator).
2. Signing: välj ditt team; appen har bundle id `ai.berget.tolk.watch`.
3. Bygg & kör. Bevilja mikrofonbehörigheten vid första start.
4. tryck **Starta textning** → skanna QR-koden med telefonen.

Krav: watchOS 10+ (deployment target 10.0). Appen pratar direkt med
`https://tolk.berget.ai`; ändra i `TolkConfig.swift` för dev mot localhost
(ckså byt till `ws://` i TolkAPI.broadcastURL).

## Kända begränsningar

- **Låskärm pausar sändningen**: watchOS suspenderar appen när handleden
  sänks/skärmen släcks och mikrofonen stannar då. Nästa steg skulle vara en
  HKWorkoutSession med `.allowBackgroundAudio` (Apples mönster för
  bakgrundsljud i träningsappar).
- Mikrofonen hämtar rumsljud – håll klockan nära talaren eller lägg den på
  bordet framför.
- IPv6/transport: URLSession sköter allt; inga särskilda krav.

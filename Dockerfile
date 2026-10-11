# syntax=docker/dockerfile:1

# ---- Build: TypeScript → dist/ -------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

# ---- Models: diarization-ONNX (laddas aldrig in i git/CC-BY-attribution i README) ----
FROM node:22-alpine AS models
WORKDIR /models
# Fastnålade sherpa-onnx releasebinärer (samma som README:s lokala steg).
RUN wget -qO seg.tar.bz2 \
      https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2 \
 && tar xf seg.tar.bz2 && rm seg.tar.bz2 \
 && wget -q https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx

# ---- Runtime --------------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=models /models ./models
COPY public ./public
# Diarization-barnprocessen spawnas relativt cwd (se src/diarizer.ts).
COPY src/diarizer-child.cjs ./src/diarizer-child.cjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/server.js"]

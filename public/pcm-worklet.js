// AudioWorklet: resamplar mikrofonljud till 24 kHz mono 16-bit PCM
// och skickar Int16Array-buffertar (~85 ms) till huvudtråden.
class PcmResampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 24000;
    this.ratio = sampleRate / this.targetRate;
    this.pending = new Float32Array(4096);
    this.pendingLen = 0;
    this.readPos = 0;
    this.out = new Int16Array(2048);
    this.outLen = 0;
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;

    // Fyll på pending-bufferten
    const need = this.pendingLen + input.length;
    if (need > this.pending.length) {
      const grown = new Float32Array(need * 2);
      grown.set(this.pending.subarray(0, this.pendingLen));
      this.pending = grown;
    }
    this.pending.set(input, this.pendingLen);
    this.pendingLen += input.length;

    // Linjär interpolering mellan sampelpositioner
    while (this.readPos + 1 < this.pendingLen) {
      const i = Math.floor(this.readPos);
      const frac = this.readPos - i;
      const s = this.pending[i] * (1 - frac) + this.pending[i + 1] * frac;
      this.out[this.outLen++] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      this.readPos += this.ratio;
      if (this.outLen === this.out.length) {
        this.port.postMessage(this.out.buffer);
        this.out = new Int16Array(2048);
        this.outLen = 0;
      }
    }

    // Släng konsumerade sampel
    const consumed = Math.floor(this.readPos);
    if (consumed > 0) {
      this.pending.copyWithin(0, consumed, this.pendingLen);
      this.pendingLen -= consumed;
      this.readPos -= consumed;
    }
    return true;
  }
}

registerProcessor('pcm-resampler', PcmResampler);

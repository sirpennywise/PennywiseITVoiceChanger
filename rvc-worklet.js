// rvc-worklet.js - Dedicated Audio Thread Processor for RVC v2 Voice Conversion
class RVCWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.hwRate = sampleRate;       // Usually 48000 Hz on iPhone USB-C DAC
    this.inTargetRate = 16000;      // HuBERT / ContentVec input rate
    this.outModelRate = 40000;      // RVC v2 generator output rate

    this.windowSize = 4096;         // 256ms context window @ 16kHz
    this.hopSize = 2048;            // 128ms step size @ 16kHz
    this.inputRing = new Float32Array(this.windowSize);
    this.samplesSinceLastHop = 0;
    this.inFracPos = 0.0;

    // Output jitter queue (at hardware sample rate)
    this.outQueueSize = 65536;
    this.outQueue = new Float32Array(this.outQueueSize);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.bufferedCount = 0;
    this.isPrebuffering = true;
    this.prebufferThreshold = Math.floor(0.05 * this.hwRate);

    // Crossfade tail at 40kHz to eliminate chunk boundary pops
    this.crossfadeLen = 512;
    this.prevTail40k = new Float32Array(this.crossfadeLen);

    this.port.onmessage = (event) => {
      if (event.data.type === 'SYNTH_CHUNK') {
        this.enqueueSynthesizedChunk(event.data.samples, event.data.modelRate);
      } else if (event.data.type === 'RESET_BUFFER') {
        this.bufferedCount = 0;
        this.readIndex = 0;
        this.writeIndex = 0;
        this.isPrebuffering = true;
      }
    };
  }

  enqueueSynthesizedChunk(chunk40k, modelRate) {
    if (modelRate) this.outModelRate = modelRate;

    const hopSamples40k = Math.floor(this.hopSize * (this.outModelRate / this.inTargetRate)); // 5120 samples @ 40kHz
    const neededLen = hopSamples40k + this.crossfadeLen;

    const startIdx = Math.max(0, chunk40k.length - neededLen);
    const cleanHop40k = new Float32Array(hopSamples40k);

    for (let i = 0; i < hopSamples40k; i++) {
      const sample = chunk40k[startIdx + i] || 0.0;
      if (i < this.crossfadeLen) {
        const fadeIn = i / this.crossfadeLen;
        const fadeOut = 1.0 - fadeIn;
        cleanHop40k[i] = (this.prevTail40k[i] * fadeOut) + (sample * fadeIn);
      } else {
        cleanHop40k[i] = sample;
      }
    }

    for (let i = 0; i < this.crossfadeLen; i++) {
      this.prevTail40k[i] = chunk40k[startIdx + hopSamples40k + i] || 0.0;
    }

    const outLengthHw = Math.floor(hopSamples40k * (this.hwRate / this.outModelRate));
    const ratio = (hopSamples40k - 1) / Math.max(1, outLengthHw - 1);

    for (let i = 0; i < outLengthHw; i++) {
      const srcPos = i * ratio;
      const idx0 = Math.floor(srcPos);
      const idx1 = Math.min(hopSamples40k - 1, idx0 + 1);
      const frac = srcPos - idx0;

      const interpolated = cleanHop40k[idx0] + frac * (cleanHop40k[idx1] - cleanHop40k[idx0]);

      this.outQueue[this.writeIndex] = interpolated;
      this.writeIndex = (this.writeIndex + 1) % this.outQueueSize;
      this.bufferedCount++;
    }

    if (this.isPrebuffering && this.bufferedCount >= this.prebufferThreshold) {
      this.isPrebuffering = false;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || !input[0] || !output || !output[0]) return true;

    const inChannel = input[0];
    const outChannel = output[0];
    const step16k = this.inTargetRate / this.hwRate;

    for (let i = 0; i < inChannel.length; i++) {
      this.inFracPos += step16k;
      if (this.inFracPos >= 1.0) {
        this.inFracPos -= 1.0;

        this.inputRing.copyWithin(0, 1);
        this.inputRing[this.windowSize - 1] = inChannel[i];
        this.samplesSinceLastHop++;

        if (this.samplesSinceLastHop >= this.hopSize) {
          this.samplesSinceLastHop = 0;

          const window16k = new Float32Array(this.inputRing);
          this.port.postMessage(
            { type: 'MIC_WINDOW_16K', window16k },
            [window16k.buffer]
          );
        }
      }
    }

    for (let i = 0; i < outChannel.length; i++) {
      if (!this.isPrebuffering && this.bufferedCount > 0) {
        outChannel[i] = this.outQueue[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.outQueueSize;
        this.bufferedCount--;
      } else {
        outChannel[i] = 0.0;
      }
    }

    return true;
  }
}

registerProcessor('rvc-worklet-processor', RVCWorkletProcessor);

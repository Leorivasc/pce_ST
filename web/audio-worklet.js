// AudioWorklet: queue of mono samples (Int16, 48 kHz) fed from the emulation
// thread through a MessagePort. If the queue runs dry it outputs silence; if it
// grows too large it drops the oldest samples so latency does not build up.
"use strict";

class PCE_STAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 1 << 17;                 // ~2.7 s at 48 kHz
    this.ring = new Float32Array(this.size);
    this.head = 0;                       // next position to read
    this.count = 0;                      // samples in the queue
    this.playing = false;
    this.underruns = 0;
    this.dropped = 0;
    this.frames = 0;
    this.peak = 0;
    const rate = sampleRate;
    this.prebuffer = Math.round(rate * 0.04);   // 40 ms before starting
    this.maxQueue = Math.round(rate * 0.25);    // above this: trim
    this.keepQueue = Math.round(rate * 0.08);
    this.port.onmessage = (ev) => {
      if (ev.data && ev.data.port) {
        ev.data.port.onmessage = (e) => this.push(e.data);
      }
    };
  }

  push(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      if (this.count === this.size) { this.head = (this.head + 1) % this.size; this.count--; this.dropped++; }
      this.ring[(this.head + this.count) % this.size] = chunk[i] / 32768;
      this.count++;
    }
    if (this.count > this.maxQueue) {
      const drop = this.count - this.keepQueue;
      this.head = (this.head + drop) % this.size;
      this.count -= drop;
      this.dropped += drop;
    }
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    const n = out.length;
    if (!this.playing && this.count >= this.prebuffer) this.playing = true;
    if (this.playing && this.count < n) { this.playing = false; this.underruns++; }
    if (this.playing) {
      for (let i = 0; i < n; i++) {
        out[i] = this.ring[this.head];
        if (Math.abs(out[i]) > this.peak) this.peak = Math.abs(out[i]);
        this.head = (this.head + 1) % this.size;
      }
      this.count -= n;
    } else {
      out.fill(0);
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    this.frames += n;
    if (this.frames >= sampleRate / 2) {
      this.frames = 0;
      this.port.postMessage({ queued: this.count, underruns: this.underruns, dropped: this.dropped, peak: this.peak });
      this.peak = 0;
    }
    return true;
  }
}

registerProcessor("pce-st-audio", PCE_STAudio);

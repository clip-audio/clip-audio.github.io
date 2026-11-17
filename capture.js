class ReplayCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batchSize = Math.round(sampleRate / 20);
    this.batch = new Int16Array(this.batchSize);
    this.length = 0;
    this.capturing = true;
    this.port.onmessage = () => {
      this.capturing = false;
      this.flush();
      this.port.postMessage(null);
    };
  }

  flush() {
    if (!this.length) return;
    const samples = this.batch.subarray(0, this.length);
    this.port.postMessage(samples, [samples.buffer]);
    this.batch = new Int16Array(this.batchSize);
    this.length = 0;
  }

  process([channels]) {
    if (!this.capturing) return false;
    if (!channels?.length) return true;
    for (let frame = 0; frame < channels[0].length; frame++) {
      let sum = 0;
      for (const channel of channels) sum += channel[frame];
      const sample = Math.max(-1, Math.min(1, sum / channels.length));
      this.batch[this.length++] = Math.round(sample * (sample < 0 ? 32768 : 32767));
      if (this.length === this.batchSize) this.flush();
    }
    return true;
  }
}

registerProcessor('replay-capture', ReplayCapture);

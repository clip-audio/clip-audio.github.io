export class AudioRing {
  constructor(rate, seconds = 600) {
    this.rate = rate;
    this.samples = new Int16Array(rate * seconds);
    this.total = 0;
    this.first = 0;
    this.bucketSize = Math.round(rate / 25);
    this.peaks = new Uint16Array(Math.ceil(this.samples.length / this.bucketSize) + 1);
  }

  get oldest() {
    return Math.max(this.first, this.total - this.samples.length);
  }

  resize(seconds) {
    const length = this.rate * seconds;
    if (length === this.samples.length) return;
    const start = Math.max(this.oldest, this.total - length);
    const retained = start < this.total ? this.copy(start, this.total) : new Int16Array();
    this.samples = new Int16Array(length);
    this.peaks = new Uint16Array(Math.ceil(length / this.bucketSize) + 1);
    this.first = this.total = start;
    this.append(retained);
  }

  append(samples) {
    for (const sample of samples) {
      this.samples[this.total % this.samples.length] = sample;
      const bucket = Math.floor(this.total / this.bucketSize) % this.peaks.length;
      if (this.total % this.bucketSize === 0) this.peaks[bucket] = 0;
      this.peaks[bucket] = Math.max(this.peaks[bucket], Math.abs(sample));
      this.total++;
    }
  }

  peak(start, end) {
    start = Math.max(this.oldest, start);
    end = Math.min(this.total, end);
    if (end <= start) return 0;
    let peak = 0;
    const first = Math.floor(start / this.bucketSize);
    const last = Math.ceil(end / this.bucketSize);
    for (let bucket = first; bucket < last; bucket++) {
      peak = Math.max(peak, this.peaks[bucket % this.peaks.length]);
    }
    return peak / 32768;
  }

  copy(start, end) {
    if (start < this.oldest || end > this.total || end <= start) {
      throw new RangeError('That selection is outside the rolling buffer.');
    }
    const result = new Int16Array(end - start);
    const offset = start % this.samples.length;
    const first = this.samples.subarray(offset, offset + result.length);
    result.set(first);
    if (first.length < result.length) result.set(this.samples.subarray(0, result.length - first.length), first.length);
    return result;
  }
}

export class SilenceFilter {
  constructor(rate) {
    this.leading = new AudioRing(rate, 1);
    this.trailing = 0;
    this.pendingStart = 0;
  }

  append(samples, buffer, threshold) {
    if (!Number.isFinite(threshold)) {
      this.trailing = 0;
      this.pendingStart = this.leading.total;
      buffer.append(samples);
      return;
    }
    let energy = 0;
    for (const sample of samples) energy += sample * sample;
    const limit = 32768 * 10 ** (threshold / 20);
    if (energy >= samples.length * limit ** 2) {
      const start = Math.max(this.pendingStart, this.leading.oldest);
      if (start < this.leading.total) buffer.append(this.leading.copy(start, this.leading.total));
      this.pendingStart = this.leading.total;
      buffer.append(samples);
      this.trailing = buffer.rate;
      return;
    }
    const count = Math.min(samples.length, this.trailing);
    if (count) buffer.append(samples.subarray(0, count));
    this.trailing -= count;
    if (count < samples.length) this.leading.append(samples.subarray(count));
  }
}

export function wav(samples, rate) {
  const header = new DataView(new ArrayBuffer(44));
  function tag(offset, value) {
    for (let i = 0; i < value.length; i++) header.setUint8(offset + i, value.charCodeAt(i));
  }
  tag(0, 'RIFF');
  header.setUint32(4, 36 + samples.byteLength, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, rate, true);
  header.setUint32(28, rate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  tag(36, 'data');
  header.setUint32(40, samples.byteLength, true);
  const pcm = new DataView(new ArrayBuffer(samples.byteLength));
  for (let i = 0; i < samples.length; i++) pcm.setInt16(i * 2, samples[i], true);
  return new Blob([header, pcm], { type: 'audio/wav' });
}

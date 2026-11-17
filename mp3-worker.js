importScripts('./lame.min.js');

self.onmessage = ({ data: { samples, rate } }) => {
  try {
    const encoder = new lamejs.Mp3Encoder(1, rate, 128);
    const chunks = [];
    for (let offset = 0; offset < samples.length; offset += 1152) {
      const encoded = encoder.encodeBuffer(samples.subarray(offset, offset + 1152));
      if (encoded.length) chunks.push(encoded);
    }
    chunks.push(encoder.flush());
    self.postMessage(new Blob(chunks, { type: 'audio/mpeg' }));
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};

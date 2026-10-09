class QueAcpPcmRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0];
    if (channels?.length && channels[0].length) {
      const pcm = new Float32Array(channels[0].length);
      for (const channel of channels) for (let i = 0; i < pcm.length; i++) pcm[i] += channel[i] / channels.length;
      this.port.postMessage(pcm, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('queacp-pcm-recorder', QueAcpPcmRecorder);

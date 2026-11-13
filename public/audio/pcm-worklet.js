class NotaPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.input = [];
    this.position = 0;
    this.ratio = sampleRate / 16000;
    this.chunk = new Int16Array(1600);
    this.offset = 0;
    this.port.onmessage = (e) => {
      if (e.data?.type === "flush") {
        while (this.position < this.input.length) {
          const i = Math.floor(this.position);
          const v = Math.max(-1, Math.min(1, this.input[i]));
          this.chunk[this.offset++] =
            v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
          if (this.offset === this.chunk.length) this.flush();
          this.position += this.ratio;
        }
        this.flush();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }
  flush() {
    if (!this.offset) return;
    const buffer = this.chunk.slice(0, this.offset).buffer;
    this.port.postMessage({ type: "pcm", buffer }, [buffer]);
    this.offset = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] ?? 0;
      this.input.push(value / channels.length);
    }
    while (this.position + 1 < this.input.length) {
      const index = Math.floor(this.position);
      const factor = this.position - index;
      const value = Math.max(
        -1,
        Math.min(
          1,
          this.input[index] * (1 - factor) + this.input[index + 1] * factor,
        ),
      );
      this.chunk[this.offset++] =
        value < 0 ? Math.round(value * 32768) : Math.round(value * 32767);
      if (this.offset === this.chunk.length) this.flush();
      this.position += this.ratio;
    }
    const used = Math.min(Math.floor(this.position), this.input.length);
    if (used) {
      this.input.splice(0, used);
      this.position -= used;
    }
    return true;
  }
}
registerProcessor("nota-pcm", NotaPcmProcessor);

function timed<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
export class RealtimeTranscriber {
  private context: AudioContext;
  private resumed: Promise<void>;
  private socket?: WebSocket;
  private source?: MediaStreamAudioSourceNode;
  private node?: AudioWorkletNode;
  private pcm: ArrayBuffer[] = [];
  private bytes = 0;
  private socketReady = false;
  private cancelled = false;
  private ending = false;
  private text = "";
  private flushed?: () => void;
  private resolveFinish?: (text: string) => void;
  private rejectFinish?: (error: Error) => void;
  private failure?: Error;
  private abort = new AbortController();
  constructor(
    private realtime: boolean,
    private onText: (text: string) => void,
  ) {
    this.context = new AudioContext({ sampleRate: 16000 });
    this.resumed = this.context.resume();
    void this.resumed.catch(() => {});
  }
  async connect(stream: MediaStream) {
    await timed(this.resumed, 7000, "音频环境启动超时，请再次点击录音。");
    if (this.cancelled) throw new Error("cancelled");
    await this.context.audioWorklet.addModule("/audio/pcm-worklet.js");
    if (this.cancelled) throw new Error("cancelled");
    this.source = this.context.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(this.context, "nota-pcm");
    this.node.port.onmessage = (event) => {
      if (event.data?.type === "flushed") {
        this.flushed?.();
        return;
      }
      if (event.data?.type !== "pcm" || this.cancelled) return;
      const raw = event.data.buffer as ArrayBuffer;
      const remaining = 16000 * 2 * 60 - this.bytes;
      if (remaining <= 0) return;
      const buffer = raw.byteLength > remaining ? raw.slice(0, remaining) : raw;
      this.bytes += buffer.byteLength;
      if (this.realtime && !this.socketReady) {
        this.pcm.push(buffer);
      } else if (this.realtime) {
        if (
          this.socket?.readyState !== WebSocket.OPEN ||
          this.socket.bufferedAmount > 1024 * 1024
        ) {
          this.fail(new Error("语音网络连接中断，请保留原音频。"));
          return;
        }
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        this.socket.send(
          JSON.stringify({ type: "audio", audio: btoa(binary) }),
        );
      } else this.pcm.push(buffer);
    };
    const muted = this.context.createGain();
    muted.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(muted);
    muted.connect(this.context.destination);
    if (this.realtime) {
      await this.connectSocket();
      if (this.cancelled) throw new Error("cancelled");
      this.socketReady = true;
      for (const buffer of this.pcm) {
        const bytes = new Uint8Array(buffer);
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        this.socket!.send(
          JSON.stringify({ type: "audio", audio: btoa(binary) }),
        );
      }
      this.pcm = [];
    }
  }
  private connectSocket() {
    return new Promise<void>((resolve, reject) => {
      const url = new URL("/api/asr", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = (this.socket = new WebSocket(url));
      let ready = false;
      const timeout = setTimeout(() => {
        reject(new Error("实时转写连接超时。"));
        this.cancel();
      }, 30000);
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "ready") {
            ready = true;
            clearTimeout(timeout);
            resolve();
          } else if (data.type === "transcript") {
            this.text = String(data.text ?? "");
            this.onText(this.text);
          } else if (data.type === "finished") {
            this.text = String(data.text ?? "");
            this.onText(this.text);
            this.resolveFinish?.(this.text);
          } else if (data.type === "error") {
            const e = new Error(String(data.message ?? "实时转写失败。"));
            clearTimeout(timeout);
            if (!ready) reject(e);
            this.fail(e);
          }
        } catch {
          this.fail(new Error("实时转写返回格式无效。"));
        }
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        const e = new Error("无法连接实时语音服务。");
        if (!ready) reject(e);
        this.fail(e);
      };
      socket.onclose = () => {
        clearTimeout(timeout);
        if (!ready) reject(new Error("语音连接提前关闭。"));
        else if (!this.cancelled && !this.ending)
          this.fail(new Error("语音连接已断开，已录音频仍可保存。"));
      };
    });
  }
  private fail(error: Error) {
    this.failure = error;
    this.rejectFinish?.(error);
    this.socket?.close();
  }
  async finish() {
    this.ending = true;
    try {
      if (this.failure) throw this.failure;
      if (this.node) {
        await timed(
          new Promise<void>((resolve) => {
            this.flushed = resolve;
            this.node!.port.postMessage({ type: "flush" });
          }),
          3000,
          "音频结束处理超时。",
        );
      }
      this.source?.disconnect();
      if (this.realtime)
        return await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("等待末句转写超时，请保留录音后重试。")),
            22000,
          );
          this.resolveFinish = (text) => {
            clearTimeout(timer);
            resolve(text);
          };
          this.rejectFinish = (error) => {
            clearTimeout(timer);
            reject(error);
          };
          if (this.socket?.readyState !== WebSocket.OPEN) {
            clearTimeout(timer);
            reject(new Error("语音连接已中断。"));
            return;
          }
          this.socket.send(JSON.stringify({ type: "finish" }));
        });
      const response = await fetch("/api/asr", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Blob(this.pcm, { type: "application/octet-stream" }),
        signal: AbortSignal.any([
          this.abort.signal,
          AbortSignal.timeout(90000),
        ]),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "转写失败。");
      if (this.cancelled) throw new Error("cancelled");
      this.text = String(data.transcript ?? "");
      this.onText(this.text);
      return this.text;
    } finally {
      this.cancel();
    }
  }
  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.abort.abort();
    this.source?.disconnect();
    this.node?.disconnect();
    this.socket?.close();
    void this.context.close();
    this.pcm = [];
  }
}

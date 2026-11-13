import WebSocket, { type RawData } from "ws";
import { TranscriptAccumulator } from "../lib/asr-protocol";
import { AppError } from "./errors";
export const maxPcmBytes = 16000 * 2 * 60;
interface AsrConfig {
  key?: string;
  endpoint?: string;
  model?: string;
}
function connectAsr(
  onReady: () => void,
  onText: (text: string) => void,
  onFinish: (text: string) => void,
  onError: () => void,
  config: AsrConfig = {},
) {
  const key =
    config.key ??
    (process.env.DASHSCOPE_ASR_API_KEY?.trim() ||
      process.env.DASHSCOPE_API_KEY?.trim());
  if (!key) throw new AppError(503, "ASR_NOT_CONFIGURED", "语音识别尚未配置。");
  const endpoint = new URL(
    config.endpoint ??
      process.env.QWEN_ASR_WEBSOCKET_URL ??
      "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
  );
  endpoint.searchParams.set(
    "model",
    config.model ?? process.env.QWEN_ASR_MODEL ?? "qwen3-asr-flash-realtime",
  );
  const transcript = new TranscriptAccumulator();
  let upstream: WebSocket | undefined;
  let ready = false;
  let finished = false;
  let cancelled = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function cancel() {
    if (cancelled) return;
    cancelled = true;
    if (timer) clearTimeout(timer);
    if (upstream?.readyState === WebSocket.CONNECTING) upstream.terminate();
    else if (upstream && upstream.readyState !== WebSocket.CLOSED)
      upstream.close();
  }
  function fail() {
    if (cancelled || finished) return;
    onError();
    cancel();
  }
  function connect() {
    if (cancelled) return;
    attempt++;
    const socket = new WebSocket(endpoint, {
      headers: { Authorization: `Bearer ${key}` },
      handshakeTimeout: 10000,
      maxPayload: 256 * 1024,
    });
    upstream = socket;
    const retry = (reason: string) => {
      if (cancelled || finished || upstream !== socket) return;
      if (timer) clearTimeout(timer);
      if (!ready && attempt < 2) {
        console.warn("nota_asr_connection_retry", { attempt, reason });
        // No audio is accepted before ready, so reconnecting here cannot duplicate audio.
        upstream = undefined;
        socket.terminate();
        connect();
      } else fail();
    };
    timer = setTimeout(() => {
      if (!ready) retry("session_ready_timeout");
    }, 12000);
    socket.on("message", (data) => {
      if (cancelled || upstream !== socket) return;
      try {
        const value = JSON.parse(data.toString()) as Record<string, unknown>;
        if (typeof value.code === "string" && !value.type) {
          console.error("nota_asr_provider_rejected", {
            code: value.code,
            reason:
              typeof value.message === "string" &&
              /model.*(?:not exist|not found|not supported)/i.test(
                value.message,
              )
                ? "model_not_available"
                : "request_rejected",
          });
          throw new Error("asr_provider_rejected");
        }
        if (value.type === "error") {
          const error = value.error as { code?: unknown } | undefined;
          console.error("nota_asr_provider_error", {
            code: typeof error?.code === "string" ? error.code : "unknown",
          });
        }
        if (value.type === "session.created")
          socket.send(
            JSON.stringify({
              event_id: crypto.randomUUID(),
              type: "session.update",
              session: {
                input_audio_format: "pcm",
                sample_rate: 16000,
                input_audio_transcription: { language: "zh" },
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.2,
                  silence_duration_ms: 800,
                },
              },
            }),
          );
        if (value.type === "session.updated" && !ready) {
          ready = true;
          if (timer) clearTimeout(timer);
          onReady();
        }
        const result = transcript.apply(value);
        if (
          value.type === "conversation.item.input_audio_transcription.text" ||
          value.type === "conversation.item.input_audio_transcription.completed"
        )
          onText(result.text);
        if (result.finished) {
          finished = true;
          onFinish(result.text);
          cancel();
        }
      } catch {
        fail();
      }
    });
    socket.on("error", (error: Error & { code?: string }) => {
      if (cancelled || upstream !== socket) return;
      const status = /Unexpected server response: (\d{3})/.exec(
        error.message,
      )?.[1];
      const reason = error.message.includes("timed out")
        ? "handshake_timeout"
        : status
          ? `http_${status}`
          : (error.code ?? "network_error");
      console.error("nota_asr_transport_error", { name: error.name, reason });
      if (status && !status.startsWith("5")) fail();
      else retry(reason);
    });
    socket.on("close", () => {
      if (!cancelled && !finished && upstream === socket)
        retry("connection_closed");
    });
  }
  connect();
  return {
    send(audio: string) {
      if (!ready || upstream?.readyState !== WebSocket.OPEN)
        throw new Error("asr_not_ready");
      upstream.send(
        JSON.stringify({
          event_id: crypto.randomUUID(),
          type: "input_audio_buffer.append",
          audio,
        }),
      );
    },
    finish() {
      if (ready && upstream?.readyState === WebSocket.OPEN)
        upstream.send(
          JSON.stringify({
            event_id: crypto.randomUUID(),
            type: "session.finish",
          }),
        );
    },
    cancel,
  };
}

export function bridgeAsr(client: WebSocket, config: AsrConfig = {}) {
  let bytes = 0;
  let ready = false;
  let ending = false;
  let closed = false;
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  let limitTimer: ReturnType<typeof setTimeout> | undefined;
  const send = (value: unknown) => {
    if (client.readyState === WebSocket.OPEN)
      client.send(JSON.stringify(value));
  };
  const upstream = connectAsr(
    () => {
      ready = true;
      limitTimer = setTimeout(() => finish(), 65000);
      send({ type: "ready" });
    },
    (text) => send({ type: "transcript", text }),
    (text) => {
      send({ type: "finished", text });
      cleanup();
      if (client.readyState === WebSocket.OPEN) client.close(1000, "finished");
    },
    () => {
      send({
        type: "error",
        message: "语音识别失败，请检查模型权限或网络后重试。已录音频仍可保留。",
      });
      cleanup();
      if (client.readyState === WebSocket.OPEN)
        client.close(1011, "asr_failed");
    },
    config,
  );
  function cleanup() {
    if (closed) return;
    closed = true;
    if (limitTimer) clearTimeout(limitTimer);
    if (endTimer) clearTimeout(endTimer);
    upstream.cancel();
  }
  function finish() {
    if (ending || closed) return;
    if (!ready) {
      send({ type: "error", message: "语音连接尚未就绪。" });
      cleanup();
      client.close();
      return;
    }
    ending = true;
    upstream.finish();
    endTimer = setTimeout(() => {
      send({ type: "error", message: "等待末句转写超时，请保留录音后重试。" });
      cleanup();
      client.close(1011, "finish_timeout");
    }, 20000);
  }
  client.on("message", (data: RawData) => {
    if (closed || ending) return;
    try {
      const message = JSON.parse(data.toString());
      if (message.type === "finish") {
        finish();
        return;
      }
      if (
        message.type !== "audio" ||
        !ready ||
        typeof message.audio !== "string" ||
        message.audio.length > 16384 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(message.audio)
      )
        throw new Error("invalid_frame");
      const chunk = Buffer.from(message.audio, "base64");
      if (!chunk.length || chunk.length % 2) throw new Error("invalid_pcm");
      bytes += chunk.length;
      if (bytes > maxPcmBytes) throw new Error("audio_limit");
      upstream.send(message.audio);
    } catch {
      send({ type: "error", message: "音频格式无效或超过60秒限制。" });
      cleanup();
      client.close(1008, "invalid_audio");
    }
  });
  client.on("close", cleanup);
  client.on("error", cleanup);
}
export async function transcribePcm(pcm: Buffer, config: AsrConfig = {}) {
  if (!pcm.length || pcm.length % 2 || pcm.length > maxPcmBytes)
    throw new AppError(400, "INVALID_PCM", "PCM音频无效或超过60秒。");
  return new Promise<string>((resolve, reject) => {
    let link: ReturnType<typeof connectAsr>;
    let offset = 0;
    let sendTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => fail(), 80000);
    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      if (sendTimer) clearTimeout(sendTimer);
      link?.cancel();
    };
    const fail = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new AppError(502, "ASR_FAILED", "转写失败，请保留录音后重试。"));
    };
    const pump = () => {
      if (done) return;
      try {
        if (offset >= pcm.length) {
          link.finish();
          return;
        }
        const chunk = pcm.subarray(offset, offset + 3200);
        offset += chunk.length;
        link.send(chunk.toString("base64"));
        sendTimer = setTimeout(pump, 20);
      } catch {
        fail();
      }
    };
    try {
      link = connectAsr(
        pump,
        () => {},
        (text) => {
          if (done) return;
          done = true;
          cleanup();
          resolve(text);
        },
        fail,
        config,
      );
    } catch {
      fail();
    }
  });
}

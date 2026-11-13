import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, WebSocket } from "ws";
import { TranscriptAccumulator } from "../src/lib/asr-protocol";
import { bridgeAsr, transcribePcm } from "../src/server/asr";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

let provider: WebSocketServer;
let gateway: WebSocketServer;
let endpoint: string;
let gatewayUrl: string;
let lastAuthorization: string | undefined;
let retryConnections = 0;
let failedConnections = 0;
before(async () => {
  provider = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => provider.on("listening", resolve));
  const address = provider.address();
  if (!address || typeof address === "string")
    throw new Error("invalid address");
  endpoint = `ws://127.0.0.1:${address.port}/realtime`;
  provider.on("connection", (socket, request) => {
    lastAuthorization = request.headers.authorization;
    if (request.url?.includes("always-close=true")) {
      failedConnections++;
      socket.terminate();
      return;
    }
    if (request.url?.includes("retry=true")) {
      retryConnections++;
      if (retryConnections === 1) {
        socket.terminate();
        return;
      }
    }
    if (request.url?.includes("reject=true")) {
      socket.send(
        JSON.stringify({
          code: "InvalidParameter",
          message: "Model not exist.",
        }),
      );
      return;
    }
    socket.send(JSON.stringify({ type: "session.created" }));
    socket.on("message", (raw) => {
      const data = JSON.parse(raw.toString());
      if (data.type === "session.update") {
        assert.equal(data.session.input_audio_format, "pcm");
        assert.equal(data.session.sample_rate, 16000);
        socket.send(JSON.stringify({ type: "session.updated" }));
      }
      if (data.type === "input_audio_buffer.append") {
        socket.send(
          JSON.stringify({
            type: "conversation.item.created",
            item: { id: "part-1" },
          }),
        );
        socket.send(
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.text",
            item_id: "part-1",
            text: "今天",
            stash: "报价",
          }),
        );
        socket.send(
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.text",
            item_id: "part-1",
            text: "今天报价",
            stash: "八万",
          }),
        );
      }
      if (data.type === "session.finish") {
        socket.send(
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.completed",
            item_id: "part-1",
            transcript: "今天报价八万元",
          }),
        );
        socket.send(JSON.stringify({ type: "session.finished" }));
      }
    });
  });
  gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => gateway.on("listening", resolve));
  const g = gateway.address();
  if (!g || typeof g === "string") throw new Error("invalid gateway");
  gatewayUrl = `ws://127.0.0.1:${g.port}`;
  gateway.on("connection", (socket) =>
    bridgeAsr(socket, { key: "test-key", endpoint }),
  );
});
after(async () => {
  for (const server of [gateway, provider]) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("partial updates replace each item rather than appending duplicates", () => {
  const a = new TranscriptAccumulator();
  a.apply({ type: "conversation.item.created", item: { id: "a" } });
  assert.equal(
    a.apply({
      type: "conversation.item.input_audio_transcription.text",
      item_id: "a",
      text: "今天",
      stash: "报价",
    }).text,
    "今天报价",
  );
  assert.equal(
    a.apply({
      type: "conversation.item.input_audio_transcription.text",
      item_id: "a",
      text: "今天报价",
      stash: "八万",
    }).text,
    "今天报价八万",
  );
  a.apply({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "a",
    transcript: "今天报价八万元",
  });
  a.apply({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "b",
    transcript: "明天发单",
  });
  assert.equal(
    a.apply({ type: "session.finished" }).text,
    "今天报价八万元\n明天发单",
  );
});
test("unfinished partial is never accepted as a completed transcript", () => {
  const a = new TranscriptAccumulator();
  a.apply({
    type: "conversation.item.input_audio_transcription.text",
    item_id: "a",
    text: "未确认",
    stash: "",
  });
  assert.throws(() => a.apply({ type: "session.finished" }), /incomplete/);
});
test("provider and per-item failures are explicit", () => {
  assert.throws(() => new TranscriptAccumulator().apply({ type: "error" }));
  assert.throws(() =>
    new TranscriptAccumulator().apply({
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "a",
    }),
  );
});
test("WebSocket bridge preserves final text and closes normally", async () => {
  const client = new WebSocket(gatewayUrl);
  const messages: Record<string, unknown>[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bridge timeout")), 3000);
    client.on("error", reject);
    client.on("message", (raw) => {
      const data = JSON.parse(raw.toString());
      messages.push(data);
      if (data.type === "ready") {
        client.send(
          JSON.stringify({
            type: "audio",
            audio: Buffer.alloc(3200).toString("base64"),
          }),
        );
        client.send(JSON.stringify({ type: "finish" }));
      }
    });
    client.on("close", (code) => {
      clearTimeout(timer);
      assert.equal(code, 1000);
      resolve();
    });
  });
  assert.equal(messages.at(-1)?.type, "finished");
  assert.equal(messages.at(-1)?.text, "今天报价八万元");
  assert.ok(
    messages.some((m) => m.type === "transcript" && m.text === "今天报价八万"),
  );
});
test("invalid browser audio is rejected instead of being forwarded", async () => {
  const client = new WebSocket(gatewayUrl);
  const received: Record<string, unknown>[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("invalid frame timeout")),
      3000,
    );
    client.on("error", reject);
    client.on("message", (raw) => {
      const value = JSON.parse(raw.toString());
      received.push(value);
      if (value.type === "ready")
        client.send(JSON.stringify({ type: "audio", audio: "not_base64!!" }));
    });
    client.on("close", (code) => {
      clearTimeout(timer);
      assert.equal(code, 1008);
      resolve();
    });
  });
  assert.ok(received.some((v) => v.type === "error"));
});
test("recorded PCM fallback uses the same provider protocol and waits for finish", async () => {
  assert.equal(
    await transcribePcm(Buffer.alloc(3200), { key: "test-key", endpoint }),
    "今天报价八万元",
  );
  await assert.rejects(
    transcribePcm(Buffer.alloc(3), { key: "test-key", endpoint }),
  );
});
test("client disconnect tears down its provider connection", async () => {
  const client = new WebSocket(gatewayUrl);
  await new Promise<void>((resolve, reject) => {
    client.on("error", reject);
    client.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "ready") {
        client.close();
        resolve();
      }
    });
  });
  const deadline = Date.now() + 1500;
  while (provider.clients.size && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(provider.clients.size, 0);
});
test("PCM worklet keeps sample phase across blocks and flushes the last samples", async () => {
  const source = await readFile("public/audio/pcm-worklet.js", "utf8");
  for (const sampleRate of [16000, 44100, 48000]) {
    interface ProcessorInstance {
      process(input: Float32Array[][]): boolean;
      port: { onmessage: (event: { data: { type: string } }) => void };
    }
    let Processor: (new () => ProcessorInstance) | undefined;
    const sent: ArrayBuffer[] = [];
    class Base {
      port = {
        onmessage: null as null | ((e: { data: { type: string } }) => void),
        postMessage: (value: { type: string; buffer: ArrayBuffer }) => {
          if (value.type === "pcm") sent.push(value.buffer);
        },
      };
    }
    vm.runInNewContext(source, {
      AudioWorkletProcessor: Base,
      sampleRate,
      registerProcessor: (_name: string, p: new () => ProcessorInstance) => {
        Processor = p;
      },
      Int16Array,
      Math,
    });
    assert.ok(Processor);
    const p = new Processor();
    for (let offset = 0; offset < sampleRate; offset += 128) {
      const samples = new Float32Array(Math.min(128, sampleRate - offset));
      samples.fill(0.5);
      p.process([[samples]]);
    }
    p.port.onmessage({ data: { type: "flush" } });
    const count = sent.reduce((sum, buffer) => sum + buffer.byteLength / 2, 0);
    assert.ok(
      Math.abs(count - 16000) <= 1,
      `sample rate ${sampleRate}: ${count}`,
    );
    for (const buffer of sent)
      assert.equal(new DataView(buffer).getInt16(0, true), 16384);
  }
});

test("empty dedicated ASR key falls back to text key; a nonempty dedicated key takes priority", async () => {
  const previousText = process.env.DASHSCOPE_API_KEY;
  const previousAsr = process.env.DASHSCOPE_ASR_API_KEY;
  try {
    process.env.DASHSCOPE_API_KEY = "fixture-text-key";
    process.env.DASHSCOPE_ASR_API_KEY = "";
    await transcribePcm(Buffer.alloc(3200), { endpoint });
    assert.equal(lastAuthorization, "Bearer fixture-text-key");
    process.env.DASHSCOPE_ASR_API_KEY = "fixture-asr-key";
    await transcribePcm(Buffer.alloc(3200), { endpoint });
    assert.equal(lastAuthorization, "Bearer fixture-asr-key");
  } finally {
    if (previousText === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = previousText;
    if (previousAsr === undefined) delete process.env.DASHSCOPE_ASR_API_KEY;
    else process.env.DASHSCOPE_ASR_API_KEY = previousAsr;
  }
});
test("an upstream rejection without an event type is an immediate failure", async () => {
  const started = Date.now();
  await assert.rejects(
    transcribePcm(Buffer.alloc(3200), {
      key: "fixture",
      endpoint: endpoint + "?reject=true",
    }),
  );
  assert.ok(
    Date.now() - started < 2000,
    "provider error must not wait for the session-ready timeout",
  );
});

test("an initial connection failure retries before any audio and finishes once", async () => {
  retryConnections = 0;
  const text = await transcribePcm(Buffer.alloc(3200), {
    key: "fixture",
    endpoint: endpoint + "?retry=true",
  });
  assert.equal(retryConnections, 2);
  assert.equal(text, "今天报价八万元");
});

test("initial connection retries stop after two unsuccessful attempts", async () => {
  failedConnections = 0;
  await assert.rejects(
    transcribePcm(Buffer.alloc(3200), {
      key: "fixture",
      endpoint: endpoint + "?always-close=true",
    }),
  );
  assert.equal(failedConnections, 2);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import ts from "typescript";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { IDBFactory } from "fake-indexeddb";
import { createRoot } from "react-dom/client";

const project = fileURLToPath(new URL("../", import.meta.url));
const buildDir = await mkdtemp(join(project, "work/recorder-test-"));
const source = await readFile(
  join(project, "src/hooks/use-voice-recorder.ts"),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
});
const hookPath = join(buildDir, "use-voice-recorder.mjs");
await writeFile(
  hookPath,
  compiled.outputText
    .replaceAll('"../lib/asr-client"', '"./asr-client.mjs"')
    .replaceAll('"../lib/audio-draft"', '"./audio-draft.mjs"')
    .replaceAll('"../lib/recorded-asr"', '"./recorded-asr.mjs"'),
);
for (const name of ["asr-client", "api", "audio-draft", "recorded-asr"]) {
  await writeFile(
    join(buildDir, `${name}.mjs`),
    ts.transpileModule(
      await readFile(join(project, `src/lib/${name}.ts`), "utf8"),
      {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
        },
      },
    ).outputText,
  );
}
const { useVoiceRecorder } = await import(pathToFileURL(hookPath).href);
await writeFile(
  join(buildDir, "demo-data.mjs"),
  ts.transpileModule(
    await readFile(join(project, "src/lib/demo-data.ts"), "utf8"),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    },
  ).outputText,
);
await writeFile(
  join(buildDir, "next-image.mjs"),
  'import React from "react"; export default function Image({src, alt, width, height, className}) { return React.createElement("img", {src, alt, width, height, className}); }',
);
await writeFile(
  join(buildDir, "next-link.mjs"),
  'import React from "react"; export default function Link({children, ...props}) { return React.createElement("a", props, children); }',
);
const appSource = await readFile(
  join(project, "src/components/nota-workspace.tsx"),
  "utf8",
);
const appCompiled = ts
  .transpileModule(appSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
    },
  })
  .outputText.replaceAll('"next/image"', '"./next-image.mjs"')
  .replaceAll('"next/link"', '"./next-link.mjs"')
  .replaceAll('"@/hooks/use-voice-recorder"', '"./use-voice-recorder.mjs"')
  .replaceAll('"@/lib/demo-data"', '"./demo-data.mjs"')
  .replaceAll('"@/lib/api"', '"./api.mjs"');
await writeFile(join(buildDir, "nota-workspace.mjs"), appCompiled);
const { NotaWorkspace } = await import(
  pathToFileURL(join(buildDir, "nota-workspace.mjs")).href
);
test.after(async () => {
  await rm(buildDir, { recursive: true });
});

async function harness(t, getMedia, App, hookOptions = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="app"></div></body></html>',
    { url: "http://localhost" },
  );
  const saved = new Map();
  function install(name, value) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const created = [];
  const revoked = [];
  const recorders = [];
  class Recorder {
    static isTypeSupported(type) {
      return type === "audio/webm;codecs=opus";
    }
    state = "inactive";
    onstop = null;
    ondataavailable = null;
    onerror = null;
    constructor(stream, options) {
      this.stream = stream;
      this.mimeType = options?.mimeType ?? "audio/webm";
      recorders.push(this);
    }
    start() {
      this.state = "recording";
    }
    stop() {
      if (this.state === "inactive") throw new Error("double stop");
      this.state = "inactive";
      queueMicrotask(() => {
        this.ondataavailable?.({
          data: new Blob(["test-audio"], { type: this.mimeType }),
        });
        this.onstop?.();
      });
    }
  }
  install("window", dom.window);
  install("document", dom.window.document);
  install(
    "navigator",
    Object.assign(dom.window.navigator, {
      mediaDevices: { getUserMedia: getMedia },
    }),
  );
  install("MediaRecorder", Recorder);
  install("indexedDB", new IDBFactory());
  install("IS_REACT_ACT_ENVIRONMENT", true);
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new dom.window.Event("close"));
  };
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => {
    const url = `blob:nota-test-${created.length}`;
    created.push({ url, blob });
    return url;
  };
  URL.revokeObjectURL = (url) => revoked.push(url);
  let current;
  function Harness() {
    current = useVoiceRecorder(hookOptions);
    return React.createElement("output", null, current.status);
  }
  let root = createRoot(dom.window.document.getElementById("app"));
  let unmounted = false;
  async function unmount() {
    if (!unmounted) {
      await act(async () => root.unmount());
      unmounted = true;
    }
  }
  t.after(async () => {
    await unmount();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    dom.window.close();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  await act(async () => root.render(React.createElement(App ?? Harness)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return {
    async settle() {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    },
    get current() {
      return current;
    },
    created,
    revoked,
    recorders,
    install,
    unmount,
    async remount(options = hookOptions) {
      await unmount();
      hookOptions = options;
      root = createRoot(dom.window.document.getElementById("app"));
      unmounted = false;
      await act(async () => {
        root.render(React.createElement(App ?? Harness));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    },
    container: dom.window.document.getElementById("app"),
  };
}

function mediaStream() {
  const track = {
    stopped: 0,
    stop() {
      this.stopped++;
    },
  };
  return { track, getTracks: () => [track] };
}

test("stop preserves final audio, releases microphone and revokes a discarded preview", async (t) => {
  const stream = mediaStream();
  const h = await harness(t, async () => stream);
  await act(async () => h.current.start());
  assert.equal(h.current.status, "recording");
  await act(async () => h.current.stop());
  await h.settle();
  assert.equal(h.current.status, "recorded");
  assert.ok(h.current.audioBlob.size > 0);
  assert.equal(h.current.audioBlob.type, "audio/webm;codecs=opus");
  assert.equal(stream.track.stopped, 1);
  const preview = h.current.audioUrl;
  await act(async () => h.current.stop());
  await h.settle();
  assert.equal(h.created.length, 1);
  await act(async () => h.current.discard());
  assert.equal(h.current.audioUrl, "");
  assert.deepEqual(h.revoked, [preview]);
});

test("closing while permission is pending rejects a late stream without starting hidden recording", async (t) => {
  const stream = mediaStream();
  let allow;
  const h = await harness(
    t,
    () =>
      new Promise((resolve) => {
        allow = resolve;
      }),
  );
  let pending;
  await act(async () => {
    pending = h.current.start();
  });
  assert.equal(h.current.status, "requesting");
  await act(async () => h.current.stop());
  await h.settle();
  assert.equal(h.current.status, "idle");
  await act(async () => {
    allow(stream);
    await pending;
  });
  assert.equal(h.recorders.length, 0);
  assert.equal(stream.track.stopped, 1);
  assert.equal(h.created.length, 0);
});

test("unmount releases an active microphone and does not create a late preview", async (t) => {
  const stream = mediaStream();
  const h = await harness(t, async () => stream);
  await act(async () => h.current.start());
  await h.unmount();
  assert.ok(stream.track.stopped >= 1);
  assert.equal(h.recorders[0].state, "inactive");
  assert.equal(h.created.length, 0);
});

test("permission denial exposes a retryable error and creates no recorder", async (t) => {
  const h = await harness(t, async () => {
    throw new DOMException("Denied", "NotAllowedError");
  });
  await act(async () => h.current.start());
  assert.equal(h.current.status, "error");
  assert.match(h.current.error, /麦克风权限/);
  assert.equal(h.recorders.length, 0);
  assert.equal(h.created.length, 0);
});

test("unmount revokes an existing preview URL", async (t) => {
  const stream = mediaStream();
  const h = await harness(t, async () => stream);
  await act(async () => h.current.start());
  await act(async () => h.current.stop());
  await h.settle();
  const preview = h.current.audioUrl;
  await h.unmount();
  assert.deepEqual(h.revoked, [preview]);
});

test("mobile voice entry opens the sheet and starts capture; close releases it; My has exactly History and Todos", async (t) => {
  const stream = mediaStream();
  const h = await harness(t, async () => stream, NotaWorkspace);
  const nav = h.container.querySelector('nav[aria-label="底部菜单"]');
  assert.deepEqual(
    [...nav.querySelectorAll("button")].map((button) =>
      button.textContent.trim(),
    ),
    ["Agent", "语音", "我的"],
  );
  await act(async () =>
    nav.querySelector('[aria-label="打开语音录音浮窗"]').click(),
  );
  const sheet = h.container.querySelector(
    'dialog[aria-labelledby="voice-title"]',
  );
  assert.ok(sheet.open);
  assert.match(sheet.textContent, /正在录音/);
  assert.equal(h.recorders.length, 1);
  await act(async () =>
    sheet.querySelector('[aria-label="关闭语音浮窗"]').click(),
  );
  assert.equal(sheet.open, false);
  assert.ok(stream.track.stopped >= 1);
  await act(async () =>
    [...nav.querySelectorAll("button")]
      .find((button) => button.textContent.trim() === "我的")
      .click(),
  );
  assert.deepEqual(
    [...h.container.querySelectorAll('[role="tab"]')].map(
      (tab) => tab.textContent,
    ),
    ["历史", "待办"],
  );
});

test("captured audio and edited transcript survive remount and are isolated by account", async (t) => {
  const h = await harness(t, async () => mediaStream(), undefined, {
    ownerId: "alice",
  });
  await act(async () => h.current.start());
  await act(async () => h.current.stop());
  await h.settle();
  const capture = h.current.audioId;
  await act(async () => h.current.saveTranscript("确认后的会议记录"));
  await h.remount();
  assert.equal(h.current.audioId, capture);
  assert.equal(h.current.recovered, true);
  assert.equal(h.current.transcript, "确认后的会议记录");
  assert.equal(await h.current.audioBlob.text(), "test-audio");
  await h.remount({ ownerId: "bob" });
  assert.equal(h.current.audioBlob, null);
  assert.equal(h.current.transcript, "");
  await h.remount({ ownerId: "alice" });
  assert.equal(h.current.audioId, capture);
  await act(async () => h.current.markUploaded());
  await h.remount();
  assert.equal(h.current.audioBlob, null);
});

test("retry converts existing raw audio to PCM and keeps a recoverable original when ASR fails", async (t) => {
  const h = await harness(t, async () => mediaStream(), undefined, {
    ownerId: "alice",
  });
  await act(async () => h.current.start());
  await act(async () => h.current.stop());
  await h.settle();
  const capture = h.current.audioId;
  let submitted;
  let closed = 0;
  h.install(
    "AudioContext",
    class {
      async decodeAudioData(bytes) {
        assert.equal(new TextDecoder().decode(bytes), "test-audio");
        return {
          length: 4,
          sampleRate: 16000,
          numberOfChannels: 1,
          getChannelData: () => Float32Array.from([0, 1, -1, 0.5]),
        };
      }
      async close() {
        closed++;
      }
    },
  );
  h.install("fetch", async (_url, options) => {
    submitted = options.body;
    return Response.json(
      { error: { message: "上游暂时不可用" } },
      { status: 502 },
    );
  });
  await act(async () => h.current.retryTranscription());
  assert.equal(submitted.byteLength, 8);
  assert.equal(new DataView(submitted).getInt16(2, true), 32767);
  assert.equal(h.current.asrStatus, "error");
  assert.match(h.current.asrError, /上游/);
  assert.equal(h.current.audioId, capture);
  assert.equal(closed, 1);
  await h.remount();
  assert.equal(h.current.audioId, capture);
  assert.equal(await h.current.audioBlob.text(), "test-audio");
  h.install("fetch", async () => Response.json({ transcript: "重新识别成功" }));
  await act(async () => h.current.retryTranscription());
  assert.equal(h.current.transcript, "重新识别成功");
  assert.equal(h.current.asrStatus, "complete");
  await h.remount();
  assert.equal(h.current.transcript, "重新识别成功");
});

test("denied rerecord preserves the previous bytes, capture identity and durable draft", async (t) => {
  let denied = false;
  const h = await harness(
    t,
    async () => {
      if (denied) throw new DOMException("Denied", "NotAllowedError");
      return mediaStream();
    },
    undefined,
    { ownerId: "alice" },
  );
  await act(async () => h.current.start());
  await act(async () => h.current.stop());
  await h.settle();
  const id = h.current.audioId;
  const blob = h.current.audioBlob;
  denied = true;
  await act(async () => h.current.start());
  assert.equal(h.current.audioId, id);
  assert.equal(h.current.audioBlob, blob);
  assert.equal(h.current.status, "recorded");
  await h.remount();
  assert.equal(h.current.audioId, id);
});

test("edits during a pending ASR retry survive completion and reload", async (t) => {
  const h = await harness(t, async () => mediaStream(), undefined, {
    ownerId: "alice",
  });
  await act(async () => h.current.start());
  await act(async () => h.current.stop());
  await h.settle();
  h.install(
    "AudioContext",
    class {
      async decodeAudioData() {
        return {
          length: 4,
          sampleRate: 16000,
          numberOfChannels: 1,
          getChannelData: () => new Float32Array(4),
        };
      }
      async close() {}
    },
  );
  let finish;
  h.install(
    "fetch",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let pending;
  await act(async () => {
    pending = h.current.retryTranscription();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await act(async () => h.current.saveTranscript("用户修正为八万元"));
  await act(async () => {
    finish(Response.json({ transcript: "模型识别十八万元" }));
    await pending;
  });
  await h.remount();
  assert.equal(h.current.transcript, "用户修正为八万元");
});

test("a slow ASR connection does not delay local recording or durable original capture", async (t) => {
  const h = await harness(t, async () => mediaStream(), undefined, {
    ownerId: "alice",
    asr: { realtime: true },
  });
  let releaseWorklet;
  h.install(
    "AudioContext",
    class {
      resume() {
        return Promise.resolve();
      }
      audioWorklet = {
        addModule: () =>
          new Promise((resolve) => {
            releaseWorklet = resolve;
          }),
      };
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      createGain() {
        return { gain: { value: 0 }, connect() {} };
      }
      async close() {}
    },
  );
  h.install(
    "AudioWorkletNode",
    class {
      port = { onmessage: null, postMessage() {} };
      connect() {}
      disconnect() {}
    },
  );
  await act(async () => h.current.start());
  assert.equal(h.current.status, "recording");
  assert.equal(h.recorders[0].state, "recording");
  assert.equal(h.current.asrStatus, "connecting");
  await act(async () => {
    releaseWorklet();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await act(async () => h.current.stop());
  await h.settle();
  assert.equal(h.current.status, "recorded");
  const id = h.current.audioId;
  await h.remount({ ownerId: "alice" });
  assert.equal(h.current.audioId, id);
  assert.equal(await h.current.audioBlob.text(), "test-audio");
});

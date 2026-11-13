import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import ts from "typescript";
import { JSDOM } from "jsdom";
import React, { act } from "react";
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
  compiled.outputText.replaceAll('"../lib/asr-client"', '"./asr-client.mjs"'),
);
for (const name of ["asr-client", "api"]) {
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

async function harness(t, getMedia, App) {
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
    current = useVoiceRecorder();
    return React.createElement("output", null, current.status);
  }
  const root = createRoot(dom.window.document.getElementById("app"));
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
  return {
    get current() {
      return current;
    },
    created,
    revoked,
    recorders,
    unmount,
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
  assert.equal(h.current.status, "recorded");
  assert.ok(h.current.audioBlob.size > 0);
  assert.equal(h.current.audioBlob.type, "audio/webm;codecs=opus");
  assert.equal(stream.track.stopped, 1);
  const preview = h.current.audioUrl;
  await act(async () => h.current.stop());
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

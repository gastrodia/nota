import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import {
  loadAudioDraft,
  saveAudioDraft,
  removeAudioDraft,
  type AudioDraft,
} from "../src/lib/audio-draft";
import { audioBufferToPcm } from "../src/lib/recorded-asr";

test("account-scoped audio store persists bytes and ignores a stale capture deletion", async () => {
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = new IDBFactory();
  try {
    const first: AudioDraft = {
      owner_id: "alice",
      id: "first",
      blob: new Blob(["private original"], { type: "audio/webm" }),
      duration_seconds: 4,
      recorded_at: "2026-11-13T00:00:00Z",
      transcript: "",
    };
    await saveAudioDraft(first);
    assert.equal(await loadAudioDraft("bob"), null);
    assert.equal(
      await (await loadAudioDraft("alice"))!.blob.text(),
      "private original",
    );
    await saveAudioDraft({
      ...first,
      id: "second",
      transcript: "new confirmed text",
    });
    await removeAudioDraft("alice", "first");
    assert.equal((await loadAudioDraft("alice"))?.id, "second");
    await removeAudioDraft("bob", "second");
    assert.equal(
      (await loadAudioDraft("alice"))?.transcript,
      "new confirmed text",
    );
    await removeAudioDraft("alice", "second");
    assert.equal(await loadAudioDraft("alice"), null);
  } finally {
    globalThis.indexedDB = previous;
  }
});

test("browser storage refusal rejects instead of claiming audio is durable", async () => {
  const previous = globalThis.indexedDB;
  Object.defineProperty(globalThis, "indexedDB", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  try {
    await assert.rejects(loadAudioDraft("alice"), /无法保存本机录音/);
  } finally {
    globalThis.indexedDB = previous;
  }
});

test("retry audio conversion downmixes stereo and bounds duration as PCM16 little endian", () => {
  const samples = Float32Array.from({ length: 48000 }, (_, i) =>
    i % 2 ? 1 : 0,
  );
  const pcm = audioBufferToPcm({
    length: samples.length,
    sampleRate: 48000,
    numberOfChannels: 2,
    getChannelData: () => samples,
  });
  assert.equal(pcm.byteLength, 32000);
  assert.equal(new DataView(pcm).getInt16(0, true), 0);
  assert.equal(new DataView(pcm).getInt16(2, true), 32767);
  assert.throws(
    () =>
      audioBufferToPcm({
        length: 48000 * 61,
        sampleRate: 48000,
        numberOfChannels: 1,
        getChannelData: () => samples,
      }),
    /超过60秒/,
  );
});

const sampleRate = 16000;
const maxDuration = 60;
/** Downmix and resample decoded audio; the HTTP ASR endpoint accepts PCM16, not WebM/MP4. */
export function audioBufferToPcm(
  audio: Pick<
    AudioBuffer,
    "length" | "sampleRate" | "numberOfChannels" | "getChannelData"
  >,
): ArrayBuffer {
  if (
    audio.length < 1 ||
    audio.sampleRate < 1 ||
    audio.numberOfChannels < 1 ||
    audio.length / audio.sampleRate > maxDuration + 0.5
  )
    throw new Error("录音无效或超过60秒，请保留原音后检查。");
  const length = Math.min(
    sampleRate * maxDuration,
    Math.floor((audio.length * sampleRate) / audio.sampleRate),
  );
  const output = new ArrayBuffer(length * 2);
  const view = new DataView(output);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, i) =>
    audio.getChannelData(i),
  );
  for (let i = 0; i < length; i++) {
    const position = (i * audio.sampleRate) / sampleRate;
    const left = Math.floor(position);
    const fraction = position - left;
    let sample = 0;
    for (const channel of channels) {
      const a = channel[left] ?? 0;
      const b = channel[Math.min(left + 1, audio.length - 1)] ?? a;
      sample += a + (b - a) * fraction;
    }
    sample = Math.max(-1, Math.min(1, sample / channels.length));
    view.setInt16(
      i * 2,
      Math.round(sample * (sample < 0 ? 32768 : 32767)),
      true,
    );
  }
  return output;
}
export async function transcribeRecordedAudio(
  blob: Blob,
  signal?: AbortSignal,
): Promise<string> {
  if (!blob.size || blob.size > 4 * 1024 * 1024)
    throw new Error("录音无效或超过4MB。");
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    signal?.throwIfAborted();
    const response = await fetch("/api/asr", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: audioBufferToPcm(decoded),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(90000)])
        : AbortSignal.timeout(90000),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error?.message ?? "转写失败，原音仍保存在本机。");
    if (typeof data.transcript !== "string" || !data.transcript.trim())
      throw new Error("没有识别到语音，原音仍保存在本机。");
    return data.transcript;
  } finally {
    await context.close();
  }
}

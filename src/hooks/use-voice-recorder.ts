"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { RealtimeTranscriber } from "../lib/asr-client";
type RecordingStatus =
  "idle" | "requesting" | "recording" | "finishing" | "recorded" | "error";
interface Options {
  asr?: { realtime: boolean; onText?: (text: string) => void };
}
function describeError(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "未获得麦克风权限，请在浏览器设置中允许后重试。";
  if (name === "NotFoundError")
    return "没有找到可用的麦克风，你也可以改用文字记录。";
  if (name === "NotReadableError")
    return "麦克风暂时不可用，可能被其他应用占用。";
  return "暂时无法开始录音，请重试或改用文字记录。";
}
export function useVoiceRecorder(options: Options = {}) {
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [duration, setDuration] = useState(0);
  const [audioUrl, setAudioUrl] = useState("");
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [error, setError] = useState("");
  const [transcript, setTranscript] = useState("");
  const [asrError, setAsrError] = useState("");
  const [asrStatus, setAsrStatus] = useState<
    "idle" | "connecting" | "listening" | "finalizing" | "complete" | "error"
  >("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const limitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urlRef = useRef("");
  const requestRef = useRef(false);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const transcriberRef = useRef<RealtimeTranscriber | null>(null);
  const optionsRef = useRef(options);
  const stopRef = useRef<() => void>(() => {});
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);
  const clearTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (limitRef.current) clearTimeout(limitRef.current);
    timerRef.current = null;
    limitRef.current = null;
  }, []);
  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);
  const start = useCallback(async () => {
    if (requestRef.current || recorderRef.current) return;
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setError("当前浏览器无法录音，请使用 HTTPS 页面或改用文字记录。");
      setStatus("error");
      return;
    }
    const generation = ++generationRef.current;
    requestRef.current = true;
    setStatus("requesting");
    setError("");
    setDuration(0);
    setTranscript("");
    setAsrError("");
    setAsrStatus("idle");
    let stream: MediaStream | null = null;
    let transcriber: RealtimeTranscriber | null = null;
    const config = optionsRef.current.asr;
    if (config) {
      try {
        transcriber = new RealtimeTranscriber(config.realtime, (text) => {
          if (mountedRef.current && generation === generationRef.current) {
            setTranscript(text);
            config.onText?.(text);
          }
        });
        transcriberRef.current = transcriber;
      } catch {
        setAsrStatus("error");
        setAsrError("当前音频环境无法进行转写，仍可保存原始录音。");
      }
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current || generation !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        transcriber?.cancel();
        return;
      }
      streamRef.current = stream;
      if (transcriber) {
        setAsrStatus("connecting");
        try {
          await transcriber.connect(stream);
          setAsrStatus("listening");
        } catch {
          transcriber.cancel();
          transcriber = null;
          transcriberRef.current = null;
          if (generation === generationRef.current) {
            setAsrStatus("error");
            setAsrError("语音识别连接失败，原始录音仍可保存或手动输入。");
          }
        }
      }
      if (!mountedRef.current || generation !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/mp4",
        "audio/webm",
      ].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      recorderRef.current = recorder;
      const chunks: BlobPart[] = [];
      const started = Date.now();
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = async () => {
        stream?.getTracks().forEach((track) => track.stop());
        if (generation !== generationRef.current || !mountedRef.current) return;
        clearTimer();
        streamRef.current = null;
        setDuration(Math.min(60, Math.floor((Date.now() - started) / 1000)));
        if (!chunks.length) {
          transcriber?.cancel();
          recorderRef.current = null;
          setStatus("error");
          setError("没有录到可播放的声音，请重试。");
          return;
        }
        const blob = new Blob(chunks, { type: recorder.mimeType });
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setAudioBlob(blob);
        setAudioUrl(url);
        if (transcriber) {
          setAsrStatus("finalizing");
          try {
            const text = await transcriber.finish();
            if (generation !== generationRef.current || !mountedRef.current)
              return;
            setTranscript(text);
            setAsrStatus("complete");
            if (!text.trim())
              setAsrError("没有识别到语音，可以重新录制或手动输入。");
          } catch (caught) {
            if (generation !== generationRef.current || !mountedRef.current)
              return;
            setAsrStatus("error");
            setAsrError(
              caught instanceof Error
                ? caught.message
                : "转写失败，原始录音已保留。",
            );
          } finally {
            transcriberRef.current = null;
          }
        }
        if (generation !== generationRef.current || !mountedRef.current) return;
        recorderRef.current = null;
        setStatus("recorded");
      };
      recorder.onerror = () => {
        if (generation !== generationRef.current || !mountedRef.current) return;
        ++generationRef.current;
        clearTimer();
        releaseStream();
        transcriber?.cancel();
        transcriberRef.current = null;
        recorderRef.current = null;
        setStatus("error");
        setError("录音意外中断，请重新录制。麦克风已释放。");
      };
      recorder.start(250);
      requestRef.current = false;
      setStatus("recording");
      timerRef.current = setInterval(
        () =>
          setDuration(Math.min(60, Math.floor((Date.now() - started) / 1000))),
        500,
      );
      limitRef.current = setTimeout(() => stopRef.current(), 60000);
    } catch (caught) {
      stream?.getTracks().forEach((track) => track.stop());
      transcriber?.cancel();
      if (generation !== generationRef.current || !mountedRef.current) return;
      recorderRef.current = null;
      streamRef.current = null;
      transcriberRef.current = null;
      requestRef.current = false;
      setStatus("error");
      setError(describeError(caught));
    }
  }, [clearTimer, releaseStream]);
  const stop = useCallback(() => {
    if (requestRef.current) {
      ++generationRef.current;
      requestRef.current = false;
      transcriberRef.current?.cancel();
      transcriberRef.current = null;
      releaseStream();
      setStatus("idle");
      return;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      setStatus("finishing");
      clearTimer();
      try {
        recorder.stop();
      } catch {
        releaseStream();
        transcriberRef.current?.cancel();
        transcriberRef.current = null;
        recorderRef.current = null;
        setStatus("error");
        setError("录音未能正常结束，请重试。");
      }
    }
  }, [clearTimer, releaseStream]);
  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);
  const discard = useCallback(() => {
    ++generationRef.current;
    requestRef.current = false;
    clearTimer();
    transcriberRef.current?.cancel();
    transcriberRef.current = null;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recorderRef.current = null;
    releaseStream();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = "";
    setAudioUrl("");
    setAudioBlob(null);
    setError("");
    setAsrError("");
    setAsrStatus("idle");
    setTranscript("");
    setDuration(0);
    setStatus("idle");
  }, [clearTimer, releaseStream]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // This is a generation counter, not a DOM ref; invalidate callbacks at cleanup.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      ++generationRef.current;
      requestRef.current = false;
      clearTimer();
      transcriberRef.current?.cancel();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      recorderRef.current = null;
      releaseStream();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [clearTimer, releaseStream]);
  return {
    status,
    duration,
    audioUrl,
    audioBlob,
    error,
    transcript,
    asrError,
    asrStatus,
    start,
    stop,
    discard,
  };
}

"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { RealtimeTranscriber } from "../lib/asr-client";
import {
  loadAudioDraft,
  saveAudioDraft,
  removeAudioDraft,
  type AudioDraft,
} from "../lib/audio-draft";
import { transcribeRecordedAudio } from "../lib/recorded-asr";
type RecordingStatus =
  "idle" | "requesting" | "recording" | "finishing" | "recorded" | "error";
interface Options {
  ownerId?: string;
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
  const [audioId, setAudioId] = useState("");
  const [recordedAt, setRecordedAt] = useState("");
  const [durabilityError, setDurabilityError] = useState("");
  const [recovered, setRecovered] = useState(false);
  const [recovering, setRecovering] = useState(true);
  const draftRef = useRef<AudioDraft | null>(null);
  const persistenceRef = useRef<Promise<void>>(Promise.resolve());
  const retryRef = useRef<AbortController | null>(null);
  const editRevisionRef = useRef(0);
  const ownerId = options.ownerId ?? "anonymous";
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
  const persist = useCallback((draft: AudioDraft) => {
    const task = persistenceRef.current
      .catch(() => {})
      .then(() => saveAudioDraft(draft));
    persistenceRef.current = task;
    void task.catch(() => {
      if (mountedRef.current && draftRef.current?.id === draft.id)
        setDurabilityError("本机录音保存失败，请下载原音后再离开页面。");
    });
    return task;
  }, []);
  const start = useCallback(async () => {
    if (requestRef.current || recorderRef.current) return;
    retryRef.current?.abort();
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setError("当前浏览器无法录音，请使用 HTTPS 页面或改用文字记录。");
      setStatus("error");
      return;
    }
    const generation = ++generationRef.current;
    const captureId = crypto.randomUUID();
    const captureTime = new Date().toISOString();
    requestRef.current = true;
    setStatus("requesting");
    setError("");
    setAsrError("");
    setAsrStatus("idle");
    let stream: MediaStream | null = null;
    let transcriber: RealtimeTranscriber | null = null;
    let connecting: Promise<void> | null = null;
    const config = optionsRef.current.asr;
    if (config) {
      try {
        transcriber = new RealtimeTranscriber(config.realtime, (text) => {
          if (mountedRef.current && generation === generationRef.current) {
            setTranscript(text);
            if (editRevisionRef.current === 0) config.onText?.(text);
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
        const current = draftRef.current;
        if (current?.id === captureId && chunks.length) {
          const captured = {
            ...current,
            blob: new Blob(chunks, { type: recorder.mimeType }),
            duration_seconds: Math.min(
              60,
              Math.floor((Date.now() - started) / 1000),
            ),
          };
          draftRef.current = captured;
          void persist(captured).catch(() => {});
        }
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
        const captured = draftRef.current;
        if (captured?.id === captureId) {
          draftRef.current = { ...captured, blob };
          // Commit original audio before waiting for the remote transcript.
          await persist(draftRef.current).catch(() => {});
        }
        await connecting;
        if (transcriber) {
          setAsrStatus("finalizing");
          try {
            const text = await transcriber.finish();
            if (generation !== generationRef.current || !mountedRef.current)
              return;
            setTranscript(text);
            const current = draftRef.current;
            if (current?.id === captureId) {
              draftRef.current = {
                ...current,
                transcript:
                  editRevisionRef.current === 0 ? text : current.transcript,
              };
              await persist(draftRef.current).catch(() => {});
            }
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
      editRevisionRef.current = 0;
      setAudioId(captureId);
      setRecordedAt(captureTime);
      setRecovered(false);
      setDurabilityError("");
      draftRef.current = {
        owner_id: optionsRef.current.ownerId ?? "anonymous",
        id: captureId,
        blob: new Blob(),
        duration_seconds: 0,
        recorded_at: captureTime,
        transcript: "",
      };
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = "";
      setAudioUrl("");
      setAudioBlob(null);
      setDuration(0);
      setTranscript("");
      requestRef.current = false;
      setStatus("recording");
      if (transcriber) {
        const activeTranscriber = transcriber;
        setAsrStatus("connecting");
        // The local recorder is already running; a network outage cannot delay capture.
        connecting = activeTranscriber
          .connect(stream)
          .then(() => {
            if (generation === generationRef.current && mountedRef.current)
              setAsrStatus("listening");
          })
          .catch(() => {
            activeTranscriber.cancel();
            transcriber = null;
            transcriberRef.current = null;
            if (generation === generationRef.current && mountedRef.current) {
              setAsrStatus("error");
              setAsrError("语音识别连接失败，原音已保留，可稍后重新转写。");
            }
          });
      }
      timerRef.current = setInterval(
        () =>
          setDuration(Math.min(60, Math.floor((Date.now() - started) / 1000))),
        500,
      );
      limitRef.current = setTimeout(() => stopRef.current(), 60000);
      return true;
    } catch (caught) {
      stream?.getTracks().forEach((track) => track.stop());
      transcriber?.cancel();
      if (generation !== generationRef.current || !mountedRef.current) return;
      recorderRef.current = null;
      streamRef.current = null;
      transcriberRef.current = null;
      requestRef.current = false;
      setStatus(draftRef.current?.blob.size ? "recorded" : "error");
      setError(describeError(caught));
    }
  }, [clearTimer, releaseStream, persist]);
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
  const discard = useCallback(
    (removeSaved = true) => {
      const current = draftRef.current;
      draftRef.current = null;
      editRevisionRef.current = 0;
      retryRef.current?.abort();
      if (removeSaved && current) {
        persistenceRef.current = persistenceRef.current
          .catch(() => {})
          .then(() => removeAudioDraft(current.owner_id, current.id));
        void persistenceRef.current.catch(() =>
          setDurabilityError("本机录音未能删除，请稍后重试。"),
        );
      }
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
      setAudioId("");
      setRecordedAt("");
      setRecovered(false);
      setError("");
      setAsrError("");
      setAsrStatus("idle");
      setTranscript("");
      setDuration(0);
      setStatus("idle");
    },
    [clearTimer, releaseStream],
  );
  useEffect(() => {
    let cancelled = false;
    // Resetting capture resources synchronizes the active account with external IndexedDB storage.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    discard(false);
    setRecovering(true);
    void persistenceRef.current
      .catch(() => {})
      .then(() => loadAudioDraft(ownerId))
      .then((saved) => {
        if (
          cancelled ||
          !saved ||
          requestRef.current ||
          recorderRef.current ||
          draftRef.current
        )
          return;
        draftRef.current = saved;
        editRevisionRef.current = saved.transcript ? 1 : 0;
        const url = URL.createObjectURL(saved.blob);
        urlRef.current = url;
        setAudioUrl(url);
        setAudioBlob(saved.blob);
        setAudioId(saved.id);
        setRecordedAt(saved.recorded_at);
        setDuration(saved.duration_seconds);
        setTranscript(saved.transcript);
        setStatus("recorded");
        setRecovered(true);
        optionsRef.current.asr?.onText?.(saved.transcript);
      })
      .catch(() => {
        if (!cancelled)
          setDurabilityError("浏览器无法恢复本机录音；新录音请先下载保留。");
      })
      .finally(() => {
        if (!cancelled) setRecovering(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ownerId, discard]);
  const restoreAudio = useCallback(
    async (
      blob: Blob,
      metadata: {
        id: string;
        recorded_at: string;
        duration_seconds: number;
        transcript: string;
      },
    ) => {
      discard(false);
      const saved = {
        ...metadata,
        blob,
        owner_id: optionsRef.current.ownerId ?? "anonymous",
      };
      const generation = generationRef.current;
      await persist(saved);
      if (
        generation !== generationRef.current ||
        saved.owner_id !== (optionsRef.current.ownerId ?? "anonymous")
      )
        return;
      draftRef.current = saved;
      editRevisionRef.current = saved.transcript ? 1 : 0;
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setAudioUrl(url);
      setAudioBlob(blob);
      setAudioId(saved.id);
      setRecordedAt(saved.recorded_at);
      setDuration(saved.duration_seconds);
      setTranscript(saved.transcript);
      setStatus("recorded");
      setRecovered(true);
    },
    [discard, persist],
  );
  const saveTranscript = useCallback(
    (text: string) => {
      editRevisionRef.current++;
      const current = draftRef.current;
      if (current) {
        draftRef.current = { ...current, transcript: text };
        if (current.blob.size) void persist(draftRef.current).catch(() => {});
      }
    },
    [persist],
  );
  const markUploaded = useCallback(async () => {
    const current = draftRef.current;
    if (!current) return;
    await persistenceRef.current.catch(() => {});
    await removeAudioDraft(current.owner_id, current.id);
  }, []);
  const retryTranscription = useCallback(async () => {
    const current = draftRef.current;
    if (!current?.blob.size || recorderRef.current || requestRef.current)
      return;
    const controller = new AbortController();
    retryRef.current?.abort();
    retryRef.current = controller;
    const generation = generationRef.current;
    editRevisionRef.current = 0;
    setAsrStatus("finalizing");
    setAsrError("");
    setStatus("finishing");
    try {
      const text = await transcribeRecordedAudio(
        current.blob,
        controller.signal,
      );
      if (controller.signal.aborted || generation !== generationRef.current)
        return;
      const latest = draftRef.current ?? current;
      draftRef.current = {
        ...latest,
        transcript: editRevisionRef.current === 0 ? text : latest.transcript,
      };
      await persist(draftRef.current).catch(() => {});
      setTranscript(text);
      if (editRevisionRef.current === 0) optionsRef.current.asr?.onText?.(text);
      setAsrStatus("complete");
    } catch (caught) {
      if (controller.signal.aborted || generation !== generationRef.current)
        return;
      setAsrStatus("error");
      setAsrError(
        caught instanceof Error
          ? caught.message
          : "转写失败，原音仍保存在本机。",
      );
    } finally {
      if (!controller.signal.aborted && generation === generationRef.current)
        setStatus("recorded");
    }
  }, [persist]);
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
      retryRef.current?.abort();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      recorderRef.current = null;
      releaseStream();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [clearTimer, releaseStream]);
  return {
    audioId,
    recordedAt,
    recovered,
    recovering,
    durabilityError,
    saveTranscript,
    markUploaded,
    retryTranscription,
    restoreAudio,
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

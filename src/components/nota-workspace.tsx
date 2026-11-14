"use client";
import Image from "next/image";
import Link from "next/link";
import { MarkdownMessage } from "@/components/markdown-message";
import { UiIcon } from "@/components/ui-icon";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useVoiceRecorder } from "@/hooks/use-voice-recorder";
import { demoNotes, type DemoNote } from "@/lib/demo-data";
import {
  api,
  pendingOperation,
  saveOperation,
  clearOperation,
} from "@/lib/api";
import type {
  User,
  Quota,
  AppStatus,
  Note,
  Todo,
  PublicJob,
} from "@/lib/contracts";

const emptyConfig: AppStatus = {
  database: false,
  model: false,
  audio_storage: false,
  asr: false,
  websocket_environment: false,
};
type NoteDetail = Note & {
  todos?: Todo[];
  job?: { id: string; status: string; error: string | null } | null;
};
type NoteDisplay = NoteDetail | DemoNote;
function subscribeDraft(notify: () => void) {
  window.addEventListener("storage", notify);
  window.addEventListener("nota:draft", notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener("nota:draft", notify);
  };
}
function serverDraft() {
  return "";
}
function clock(seconds: number) {
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
function date(value: string | null | undefined) {
  if (!value) return "未设截止时间";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "时间未知"
    : new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(parsed);
}
function message(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}
function conversation(owner: string) {
  try {
    const value = localStorage.getItem(`nota:conversation:${owner}`);
    if (value && /^[0-9a-f-]{36}$/i.test(value)) return value;
  } catch {}
  const value = crypto.randomUUID();
  try {
    localStorage.setItem(`nota:conversation:${owner}`, value);
  } catch {}
  return value;
}

export function NotaWorkspace() {
  const [screen, setScreen] = useState<"agent" | "mine">("agent");
  const [mineTab, setMineTab] = useState<"history" | "todos">("history");
  const [example, setExample] = useState<"history" | "todo" | null>(null);
  const [question, setQuestion] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [demoDone, setDemoDone] = useState(false);
  const [note, setNote] = useState<NoteDisplay>(demoNotes[0]);
  const [user, setUser] = useState<User | null>(null);
  const ownerRef = useRef<User | null>(null);
  const [config, setConfig] = useState<AppStatus>(emptyConfig);
  const [usage, setUsage] = useState<Quota | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [jobs, setJobs] = useState<PublicJob[]>([]);
  const [activeJob, setActiveJob] = useState<PublicJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [voiceMode, setVoiceMode] = useState<"audio" | "text">("audio");
  const [editedDraft, setEditedDraft] = useState<string | null>(null);
  const [draftNotice, setDraftNotice] = useState("");
  const manualEdit = useRef(false);
  const [voiceNoteId, setVoiceNoteId] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const voiceDialog = useRef<HTMLDialogElement>(null);
  const sourceDialog = useRef<HTMLDialogElement>(null);
  const authDialog = useRef<HTMLDialogElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const watcher = useRef<AbortController | null>(null);
  const conversationId = useRef("");
  const draftKey = `nota:draft:${user?.id ?? "anonymous"}`;
  const readDraft = useCallback(() => {
    try {
      return localStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  }, [draftKey]);
  const storedDraft = useSyncExternalStore(
    subscribeDraft,
    readDraft,
    serverDraft,
  );
  const draft = editedDraft ?? storedDraft;
  const recorder = useVoiceRecorder({
    ownerId: user?.id,
    asr:
      user && config.asr
        ? {
            realtime: config.websocket_environment,
            onText: (text) => {
              if (!manualEdit.current) setEditedDraft(text);
            },
          }
        : undefined,
  });
  const recording = recorder.status === "recording";
  const waiting =
    recorder.status === "requesting" || recorder.status === "finishing";
  const displayNotes: NoteDisplay[] = user
    ? notes
    : demoNotes.filter((record) =>
        `${record.title}${record.transcript}`.includes(search.trim()),
      );

  async function refresh(owner: User) {
    const [me, n, t] = await Promise.all([
      api<{ user: User | null; quota: Quota | null }>("me"),
      api<{ notes: Note[] }>(`notes?q=${encodeURIComponent(search)}`),
      api<{ todos: Todo[] }>("todos"),
    ]);
    if (ownerRef.current?.id !== owner.id) return;
    setUsage(me.quota);
    setNotes(n.notes);
    setTodos(t.todos);
  }
  function mergeJob(job: PublicJob) {
    setActiveJob(job);
    if (job.kind === "chat" || job.result?.needs_clarification)
      setJobs((previous) =>
        [...previous.filter((j) => j.id !== job.id), job].sort((a, b) =>
          a.created_at.localeCompare(b.created_at),
        ),
      );
  }
  async function watchJob(id: string, owner: User) {
    watcher.current?.abort();
    const controller = new AbortController();
    watcher.current = controller;
    setBusy(true);
    setNotice("");
    let runSettled = false;
    let runError: unknown;
    try {
      const initial = (
        await api<{ job: PublicJob }>(`jobs/${id}`, {
          signal: controller.signal,
        })
      ).job;
      mergeJob(initial);
      if (initial.status !== "succeeded")
        void api<{ job: PublicJob }>(`jobs/${id}/run`, {
          method: "POST",
          signal: controller.signal,
        })
          .catch((error) => {
            runError = error;
          })
          .finally(() => {
            runSettled = true;
          });
      else runSettled = true;
      const deadline = Date.now() + 250000;
      while (!controller.signal.aborted && Date.now() < deadline) {
        const current = (
          await api<{ job: PublicJob }>(`jobs/${id}`, {
            signal: controller.signal,
          })
        ).job;
        if (ownerRef.current?.id !== owner.id) return;
        mergeJob(current);
        if (current.status === "succeeded") {
          clearOperation(owner.id, current.kind);
          await refresh(owner);
          if (current.kind === "note" && current.note_id === recorder.audioId)
            await recorder.markUploaded();
          if (current.result?.needs_clarification) {
            voiceDialog.current?.close();
            setScreen("agent");
            return;
          }
          if (
            current.kind === "note" &&
            voiceDialog.current?.open &&
            current.note_id
          ) {
            voiceDialog.current.close();
            setScreen("mine");
            setMineTab("history");
            await showSource(current.note_id);
          }
          return;
        }
        if (
          current.status === "failed" &&
          (current.attempt > initial.attempt || runSettled)
        ) {
          await refresh(owner);
          setNotice(
            runError
              ? message(runError)
              : (current.error ?? "处理失败，可重试原任务。"),
          );
          return;
        }
        if (runError && current.status === "pending") throw runError;
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          };
          const timer = setTimeout(() => {
            controller.signal.removeEventListener("abort", abort);
            resolve();
          }, 1100);
          controller.signal.addEventListener("abort", abort, { once: true });
        });
      }
      if (!controller.signal.aborted)
        setNotice("处理仍在继续，可以稍后点击“继续查看”恢复原任务。");
    } catch (error) {
      if (!controller.signal.aborted) setNotice(message(error));
    } finally {
      if (watcher.current === controller) {
        controller.abort();
        setBusy(false);
      }
    }
  }
  const refreshFromEffect = useEffectEvent(refresh);
  const watchFromEffect = useEffectEvent(watchJob);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [status, me] = await Promise.all([
          api<AppStatus>("status"),
          api<{ user: User | null; quota: Quota | null }>("me"),
        ]);
        if (cancelled) return;
        setConfig(status);
        ownerRef.current = me.user;
        setUser(me.user);
        setUsage(me.quota);
        if (me.user) {
          conversationId.current = conversation(me.user.id);
          await refreshFromEffect(me.user);
          const history = await api<{ jobs: PublicJob[] }>(
            `jobs?conversation_id=${conversationId.current}`,
          );
          if (cancelled) return;
          setJobs(history.jobs);
          let pending = history.jobs.find(
            (j) => j.status === "pending" || j.status === "running",
          );
          try {
            const noteOp = JSON.parse(
              localStorage.getItem(`nota:operation:${me.user.id}:note`) ??
                "null",
            );
            if (noteOp?.job_id)
              pending = (await api<{ job: PublicJob }>(`jobs/${noteOp.job_id}`))
                .job;
          } catch {}
          if (
            pending &&
            pending.status !== "succeeded" &&
            pending.status !== "failed"
          )
            void watchFromEffect(pending.id, me.user);
        }
      } catch (error) {
        if (!cancelled) setNotice(message(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      watcher.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api<{ notes: Note[] }>(`notes?q=${encodeURIComponent(search)}`, {
        signal: controller.signal,
      })
        .then((data) => {
          if (!controller.signal.aborted) setNotes(data.notes);
        })
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search, user]);
  useEffect(() => {
    if (example || jobs.length)
      chatEnd.current?.scrollIntoView({ block: "end" });
  }, [example, jobs]);
  function openAuth() {
    setAuthError("");
    authDialog.current?.showModal();
  }
  async function submitAuth(event: React.FormEvent) {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError("");
    try {
      const result = await api<{ user: User; quota: Quota }>(
        `auth/${authMode}`,
        { method: "POST", body: JSON.stringify({ email, password }) },
      );
      ownerRef.current = result.user;
      setUser(result.user);
      manualEdit.current = false;
      setEditedDraft(null);
      setVoiceNoteId(null);
      setUsage(result.quota);
      conversationId.current = conversation(result.user.id);
      setJobs([]);
      setExample(null);
      setPassword("");
      authDialog.current?.close();
      await refresh(result.user);
    } catch (error) {
      setAuthError(message(error));
    } finally {
      setAuthBusy(false);
    }
  }
  async function logout() {
    try {
      await api("auth/logout", { method: "POST" });
      watcher.current?.abort();
      recorder.discard(false);
      setVoiceNoteId(null);
      voiceDialog.current?.close();
      sourceDialog.current?.close();
      ownerRef.current = null;
      setUser(null);
      setUsage(null);
      setNotes([]);
      setTodos([]);
      setJobs([]);
      setActiveJob(null);
      setEditedDraft(null);
      setNotice("");
      setBusy(false);
    } catch (error) {
      setNotice(message(error));
    }
  }
  function newChat() {
    if (busy) {
      setNotice("当前任务仍在处理，请先等待完成。");
      return;
    }
    setExample(null);
    setJobs([]);
    setActiveJob(null);
    setNotice("");
    if (user) {
      conversationId.current = crypto.randomUUID();
      try {
        localStorage.setItem(
          `nota:conversation:${user.id}`,
          conversationId.current,
        );
      } catch {}
    }
  }
  function startRecording() {
    if (
      recorder.audioBlob &&
      !window.confirm("重新录制会替换本机尚未整理的录音，继续吗？")
    )
      return;
    manualEdit.current = false;
    setDraftNotice("");
    void recorder.start().then((started) => {
      if (started) {
        setEditedDraft("");
        setVoiceNoteId(null);
      }
    });
  }
  function openVoice() {
    if (voiceDialog.current?.open) return;
    setVoiceMode("audio");
    voiceDialog.current?.showModal();
    if (
      !recorder.recovering &&
      (recorder.status === "idle" || recorder.status === "error")
    )
      startRecording();
  }
  function closeVoice() {
    recorder.stop();
    voiceDialog.current?.close();
  }
  function openText() {
    recorder.stop();
    setVoiceMode("text");
    setDraftNotice("");
    if (editedDraft === null) setEditedDraft(storedDraft);
    if (!voiceDialog.current?.open) voiceDialog.current?.showModal();
  }
  function saveDraft() {
    if (!draft.trim()) {
      setDraftNotice("先输入需要记录的内容。");
      return;
    }
    try {
      localStorage.setItem(draftKey, draft.trim());
      recorder.saveTranscript(draft.trim());
      window.dispatchEvent(new Event("nota:draft"));
      setDraftNotice("文字草稿已保存到当前浏览器。");
    } catch {
      setDraftNotice("浏览器无法保存，请先复制文字保留。");
    }
  }
  function removeDraft() {
    if (busy || waiting || recording) return;
    if (!window.confirm("删除当前浏览器中的文字草稿？")) return;
    try {
      localStorage.removeItem(draftKey);
      manualEdit.current = true;
      setEditedDraft(null);
      window.dispatchEvent(new Event("nota:draft"));
      setDraftNotice("本机文字草稿已删除。");
    } catch {
      const error = "浏览器无法删除草稿，请稍后重试。";
      setDraftNotice(error);
      setNotice(error);
    }
  }
  async function saveOriginalAudio(input = draft) {
    const owner = ownerRef.current;
    if (!owner) {
      openAuth();
      return null;
    }
    if (!recorder.audioBlob) return null;
    if (!config.audio_storage)
      throw new Error("私有音频存储尚未配置，原音保留在本机，请先下载备份。");
    const noteId = voiceNoteId ?? recorder.audioId;
    await api<{ note: Note }>("notes", {
      method: "POST",
      body: JSON.stringify({
        id: noteId,
        source: "voice",
        transcript: input.trim(),
        duration_seconds: Math.min(60, recorder.duration),
        recorded_at: recorder.recordedAt,
      }),
    });
    const existing = (await api<{ note: NoteDetail }>(`notes/${noteId}`)).note;
    if (!existing.has_audio) {
      const form = new FormData();
      form.set("audio", recorder.audioBlob, "recording");
      await api(`notes/${noteId}/audio`, { method: "POST", body: form });
    }
    if (ownerRef.current?.id !== owner.id) return null;
    setVoiceNoteId(noteId);
    await refresh(owner);
    return noteId;
  }
  async function saveOriginalOnly() {
    setBusy(true);
    try {
      const saved = await saveOriginalAudio();
      if (saved)
        setDraftNotice("原始录音已私有保存到云端，可稍后继续转写和整理。");
    } catch (error) {
      setDraftNotice(message(error));
    } finally {
      setBusy(false);
    }
  }
  async function submitJob(
    kind: "chat" | "note",
    input: string,
    includeAudio = true,
  ) {
    const owner = ownerRef.current;
    if (!owner) {
      openAuth();
      return;
    }
    if (!input.trim()) {
      setDraftNotice("请先确认要整理的文字。");
      return;
    }
    if (busy) return;
    if (
      kind === "note" &&
      includeAudio &&
      recorder.audioBlob &&
      !config.audio_storage
    ) {
      setDraftNotice(
        "私有音频存储尚未配置。请先下载保留录音，或明确选择“仅整理文字”。",
      );
      return;
    }
    setBusy(true);
    setNotice("");
    setDraftNotice("");
    try {
      if (kind === "note") {
        localStorage.setItem(draftKey, input.trim());
        window.dispatchEvent(new Event("nota:draft"));
      }
      const fingerprint = JSON.stringify({
        input: input.trim(),
        conversation: conversationId.current,
        audio:
          kind === "note" && includeAudio && recorder.audioBlob
            ? {
                capture: recorder.audioId,
                size: recorder.audioBlob.size,
                type: recorder.audioBlob.type,
              }
            : null,
      });
      const op = pendingOperation(owner.id, kind, fingerprint);
      if (kind === "note" && voiceNoteId) op.note_id = voiceNoteId;
      if (kind === "note" && includeAudio && recorder.audioBlob) {
        const saved = await saveOriginalAudio(input);
        if (!saved) return;
        op.note_id = saved;
        op.audio_uploaded = true;
        saveOperation(owner.id, kind, op);
      }
      if (!op.job_id) {
        const result = await api<{ job: PublicJob }>("jobs", {
          method: "POST",
          body: JSON.stringify({
            kind,
            input: input.trim(),
            idempotency_key: op.idempotency_key,
            conversation_id: conversationId.current,
            ...(op.note_id ? { note_id: op.note_id } : {}),
          }),
        });
        op.job_id = result.job.id;
        saveOperation(owner.id, kind, op);
      }
      if (kind === "chat") setQuestion("");
      else {
        try {
          localStorage.removeItem(draftKey);
          window.dispatchEvent(new Event("nota:draft"));
        } catch {}
      }
      await watchJob(op.job_id, owner);
    } catch (error) {
      setNotice(message(error));
      if (kind === "note") setDraftNotice(message(error));
      setBusy(false);
    }
  }
  async function sendQuestion(event: React.FormEvent) {
    event.preventDefault();
    if (question.trim()) await submitJob("chat", question);
  }
  async function showSource(value: string | DemoNote) {
    try {
      if (typeof value === "string") {
        setNote((await api<{ note: NoteDetail }>(`notes/${value}`)).note);
      } else setNote(value);
      sourceDialog.current?.showModal();
    } catch (error) {
      setNotice(message(error));
    }
  }
  async function toggleTodo(todo: Todo) {
    try {
      const result = await api<{ todo: Todo }>(`todos/${todo.id}`, {
        method: "PATCH",
        body: JSON.stringify({ completed: !todo.completed }),
      });
      setTodos((previous) =>
        previous.map((t) => (t.id === todo.id ? result.todo : t)),
      );
    } catch (error) {
      setNotice(message(error));
    }
  }
  async function removeNote() {
    if (!user || !("status" in note)) return;
    if (!window.confirm("删除这条便签及关联待办？原始音频也会一并清理。"))
      return;
    try {
      await api(`notes/${note.id}`, { method: "DELETE" });
      sourceDialog.current?.close();
      await refresh(user);
    } catch (error) {
      setNotice(message(error));
    }
  }
  function renderJob(job: PublicJob) {
    const tools = job.events.filter((e) => e.type === "tool_result");
    return (
      <div className="conversation" key={job.id}>
        <div className="user-bubble">{job.input}</div>
        <div className="assistant-row">
          <Image
            src="/art/agent.png"
            width={34}
            height={34}
            alt=""
            className="pixel-art"
          />
          <div className="assistant-bubble">
            {job.status === "succeeded" && job.result ? (
              <>
                <MarkdownMessage>
                  {job.result.answer || job.result.summary}
                </MarkdownMessage>
                {job.result.todos.map((todo) => (
                  <div className="message-task" key={todo.id}>
                    <span>
                      <UiIcon name="check" />
                    </span>
                    <div>
                      <strong>{todo.title}</strong>
                      <small>{date(todo.due_at)}</small>
                    </div>
                  </div>
                ))}
                {job.result.queried_todos?.map((todo) => (
                  <div className="message-task" key={`queried-${todo.id}`}>
                    <span>
                      <UiIcon name={todo.completed ? "check" : "circle"} />
                    </span>
                    <div>
                      <strong>{todo.title}</strong>
                      <small>
                        {todo.completed ? "已完成" : "未完成"} · 截止：
                        {date(todo.due_at)}
                      </small>
                      {todo.note_id && (
                        <button
                          className="source-link"
                          onClick={() => void showSource(todo.note_id!)}
                        >
                          查看来源 ↗
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {job.result.sources.map((source) => (
                  <button
                    key={source.id}
                    className="source-link"
                    onClick={() => void showSource(source.id)}
                  >
                    来源：{source.title} ↗
                  </button>
                ))}
              </>
            ) : (
              <>
                <p>
                  {job.status === "failed"
                    ? job.error
                    : job.status === "pending"
                      ? "正在等待处理…"
                      : "正在整理与执行…"}
                </p>
                {!busy && (
                  <button
                    className="source-link"
                    onClick={() => user && void watchJob(job.id, user)}
                  >
                    {job.status === "failed" ? "重试原任务" : "继续查看"} →
                  </button>
                )}
              </>
            )}
            {tools.length > 0 && (
              <details className="tool-trace">
                <summary>
                  工具调用过程 <span>{tools.length} 次</span>
                </summary>
                {tools.map((e) => (
                  <div key={e.id}>
                    <code>{String(e.payload.name)}</code>
                    <pre>{JSON.stringify(e.payload.args, null, 2)}</pre>
                    <p>
                      {(e.payload.result as { ok?: boolean })?.ok
                        ? "执行成功"
                        : "参数或执行失败"}
                    </p>
                  </div>
                ))}
              </details>
            )}
          </div>
        </div>
      </div>
    );
  }
  const noteIsReal = "status" in note;
  return (
    <div className="phone-app">
      <header className="app-header">
        <Link href="/" className="brand" aria-label="Nota AI 语音便签首页">
          Nota<span>.</span>
          <small>AI 语音便签</small>
        </Link>
        <span className="preview-pill">
          <i />
          {config.test_mode
            ? "联调测试"
            : user
              ? "已登录"
              : loading
                ? "连接中"
                : "访客体验"}
        </span>
      </header>
      {screen === "agent" ? (
        <>
          <main className="screen agent-screen" aria-label="Agent 问答">
            <div className="agent-heading">
              <div>
                <h1>Agent</h1>
                <p>查找记录，也帮你把事情办了。</p>
              </div>
              <button
                className="new-chat"
                onClick={newChat}
                aria-label="新建对话"
              >
                <UiIcon name="plus" />
              </button>
            </div>
            {user && jobs.length > 0 ? (
              jobs.map(renderJob)
            ) : !example ? (
              <div className="agent-welcome">
                <div className="agent-portrait">
                  <Image
                    src="/art/agent.png"
                    width={88}
                    height={88}
                    alt="像素风对话气泡"
                    className="pixel-art"
                    preload
                  />
                </div>
                <span className="little-label">YOUR EVERYDAY ASSISTANT</span>
                <h2>你好，我是 Nota</h2>
                <p>
                  想查之前的记录，还是有件事要办？
                  <br />
                  直接问我，也可以点下方语音说给我听。
                </p>
                <div className="suggestions">
                  <span>{user ? "从一个问题开始" : "了解功能 · 示例"}</span>
                  <button
                    onClick={() =>
                      user
                        ? void submitJob("chat", "之前给客户的报价是多少？")
                        : setExample("history")
                    }
                  >
                    <span className="suggestion-mark mint">?</span>
                    <span>
                      <strong>之前给客户的报价是多少？</strong>
                      <small>查询历史，回答附上来源</small>
                    </span>
                    <b>↗</b>
                  </button>
                  <button
                    onClick={() =>
                      user
                        ? setQuestion("帮我创建一个待办：")
                        : setExample("todo")
                    }
                  >
                    <span className="suggestion-mark peach">
                      <UiIcon name="check" />
                    </span>
                    <span>
                      <strong>帮我创建发送报价单的待办</strong>
                      <small>
                        {user
                          ? "说清楚要做的事和时间"
                          : "查看工具调用与执行结果示例"}
                      </small>
                    </span>
                    <b>↗</b>
                  </button>
                </div>
              </div>
            ) : (
              <div className="conversation" aria-label="示例对话">
                <div className="example-divider">
                  <span>示例对话 · 非真实模型回复</span>
                </div>
                <div className="user-bubble">
                  {example === "history"
                    ? "之前和客户确认的基础版报价是多少？"
                    : "帮我创建一个待办，明天下午三点发送报价单。"}
                </div>
                <div className="assistant-row">
                  <Image
                    src="/art/agent.png"
                    width={34}
                    height={34}
                    alt=""
                    className="pixel-art"
                  />
                  <div className="assistant-bubble">
                    <p>
                      {example === "history" ? (
                        <>
                          基础版报价为 <strong>8 万元</strong>。
                        </>
                      ) : (
                        "待办执行结果示例：发送报价单。"
                      )}
                    </p>
                    <button
                      className="source-link"
                      onClick={() => void showSource(demoNotes[0])}
                    >
                      查看来源便签 ↗
                    </button>
                    <details className="tool-trace">
                      <summary>
                        工具调用过程 <span>示例</span>
                      </summary>
                      <code>
                        {example === "history" ? "search_notes" : "create_todo"}
                      </code>
                    </details>
                  </div>
                </div>
                <p className="conversation-note">
                  以上为固定示例。登录后使用真实记录。
                </p>
                <button className="another-example" onClick={openAuth}>
                  登录 / 注册 →
                </button>
              </div>
            )}
            <div ref={chatEnd} />
          </main>
          <form className="chat-composer" onSubmit={sendQuestion}>
            {notice && (
              <p className="app-notice composer-notice" role="status">
                {notice}
              </p>
            )}
            <div className="composer-field">
              <label htmlFor="agent-question" className="sr-only">
                向 Agent 提问
              </label>
              <input
                id="agent-question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="问点什么，或让我帮你办事…"
                maxLength={10000}
                autoComplete="off"
              />
              <button
                type="submit"
                disabled={!question.trim() || busy}
                aria-label="发送问题"
              >
                <UiIcon name="arrow-up" />
              </button>
            </div>
            <p className="composer-hint">
              {busy
                ? "任务处理中，关闭页面后可恢复"
                : user
                  ? `今日剩余 ${usage?.remaining ?? "—"} / 10 次 AI 处理`
                  : "登录后可问答、查询记录和执行待办"}
            </p>
          </form>
        </>
      ) : (
        <main className="screen mine-screen" aria-label="我的">
          <div className="mine-heading">
            <h1>我的</h1>
            <span>你的记录，都在这里</span>
          </div>
          <section className="profile-card">
            <div className="profile-avatar">
              <Image
                src="/art/profile.png"
                width={55}
                height={55}
                alt=""
                className="pixel-art"
              />
            </div>
            <div>
              <h2>{user ? user.email.split("@")[0] : "访客体验"}</h2>
              <p>{user ? user.email : "登录后同步便签和待办"}</p>
            </div>
            <span className="free-pill">Free</span>
            <div className="quota-line">
              <span>每日 AI 处理额度</span>
              <strong>
                {usage?.remaining ?? "—"}
                <small> / 10 次剩余</small>
              </strong>
              <span>{user ? "北京时间零点更新" : "未登录"}</span>
            </div>
            <button
              className="profile-auth"
              onClick={() => (user ? void logout() : openAuth())}
            >
              {user ? "退出登录" : "登录 / 注册"}
            </button>
          </section>
          {notice && (
            <p className="app-notice" role="status">
              {notice}
            </p>
          )}
          <div className="mine-tabs" role="tablist" aria-label="我的内容">
            <button
              id="history-tab"
              role="tab"
              aria-selected={mineTab === "history"}
              aria-controls="history-panel"
              className={mineTab === "history" ? "active" : ""}
              onClick={() => setMineTab("history")}
            >
              历史
            </button>
            <button
              id="todos-tab"
              role="tab"
              aria-selected={mineTab === "todos"}
              aria-controls="todos-panel"
              className={mineTab === "todos" ? "active" : ""}
              onClick={() => setMineTab("todos")}
            >
              待办
            </button>
          </div>
          {mineTab === "history" ? (
            <section
              id="history-panel"
              role="tabpanel"
              aria-labelledby="history-tab"
            >
              <label className="history-search">
                <span aria-hidden="true">
                  <UiIcon name="search" />
                </span>
                <span className="sr-only">搜索历史</span>
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索记录内容…"
                />
              </label>
              {recorder.audioBlob && (
                <div className="draft-card">
                  <button className="draft-open" onClick={openVoice}>
                    <span>本机录音 · 可继续</span>
                    <p>{recorder.transcript || "原音已保留，可重新转写"}</p>
                    <small>{clock(recorder.duration)} · 继续 ↗</small>
                  </button>
                </div>
              )}
              {storedDraft && (
                <div className="draft-card">
                  <button className="draft-open" onClick={openText}>
                    <span>本机草稿 · 未处理</span>
                    <p>{storedDraft}</p>
                    <small>继续编辑 ↗</small>
                  </button>
                  <button
                    className="draft-delete"
                    disabled={busy || waiting || recording}
                    onClick={removeDraft}
                  >
                    删除草稿
                  </button>
                </div>
              )}
              <div className="list-caption">
                <span>{user ? "历史记录" : "历史记录示例"}</span>
                <span>{displayNotes.length} 条</span>
              </div>
              <div className="note-list">
                {displayNotes.map((record) => (
                  <button
                    className="note-card"
                    key={record.id}
                    onClick={() =>
                      void showSource("status" in record ? record.id : record)
                    }
                  >
                    <div className="note-meta">
                      <time>
                        {"created_at" in record
                          ? date(record.created_at)
                          : record.time}
                      </time>
                      <span>
                        {"duration_seconds" in record
                          ? record.duration_seconds === null
                            ? "文字"
                            : `${record.duration_seconds} 秒`
                          : record.duration}
                      </span>
                    </div>
                    <h3>{record.title}</h3>
                    <p>
                      {record.summary || record.transcript || "等待转写与整理"}
                    </p>
                    <div className="note-footer">
                      <span>
                        {"status" in record
                          ? {
                              draft: "待整理",
                              processing: "处理中",
                              ready: "已整理",
                              failed: "处理失败",
                            }[record.status]
                          : record.task
                            ? "✓ 含待办"
                            : "摘要"}
                      </span>
                      <span>查看详情 ↗</span>
                    </div>
                  </button>
                ))}
                {!displayNotes.length && (
                  <p className="empty-state">还没有记录，点下方语音开始吧。</p>
                )}
                {user && notes.length >= 30 && (
                  <button
                    className="another-example"
                    onClick={() =>
                      void api<{ notes: Note[] }>(
                        `notes?q=${encodeURIComponent(search)}&offset=${notes.length}`,
                      )
                        .then((data) =>
                          setNotes((previous) => [...previous, ...data.notes]),
                        )
                        .catch((error) => setNotice(message(error)))
                    }
                  >
                    加载更早的记录 →
                  </button>
                )}
              </div>
            </section>
          ) : (
            <section
              id="todos-panel"
              role="tabpanel"
              aria-labelledby="todos-tab"
            >
              <div className="list-caption">
                <span>{user ? "待办事项" : "待办示例"}</span>
                <span>
                  {user
                    ? `${todos.filter((t) => !t.completed).length} 项未完成`
                    : demoDone
                      ? "已完成"
                      : "1 项未完成"}
                </span>
              </div>
              {user ? (
                todos.map((todo) => (
                  <div
                    key={todo.id}
                    className={`todo-card ${todo.completed ? "done" : ""}`}
                  >
                    <label>
                      <input
                        type="checkbox"
                        checked={todo.completed}
                        onChange={() => void toggleTodo(todo)}
                      />
                      <span>
                        <strong>{todo.title}</strong>
                        <small>截止：{date(todo.due_at)}</small>
                      </span>
                    </label>
                    {todo.note_id && (
                      <button
                        className="source-link"
                        onClick={() => void showSource(todo.note_id!)}
                      >
                        查看来源便签 ↗
                      </button>
                    )}
                    <div className="todo-state">
                      {todo.completed ? "✓ 已完成" : "未完成"}
                    </div>
                  </div>
                ))
              ) : (
                <div className={`todo-card ${demoDone ? "done" : ""}`}>
                  <label>
                    <input
                      type="checkbox"
                      checked={demoDone}
                      onChange={(e) => setDemoDone(e.target.checked)}
                    />
                    <span>
                      <strong>发送报价单</strong>
                      <small>截止：2026/11/13 15:00</small>
                    </span>
                  </label>
                  <button
                    className="source-link"
                    onClick={() => void showSource(demoNotes[0])}
                  >
                    来自「客户方案与报价确认」↗
                  </button>
                  <div className="todo-state">
                    {demoDone ? "✓ 已完成" : "未完成"}
                    <span>示例状态仅本次预览有效</span>
                  </div>
                </div>
              )}
              {user && !todos.length && (
                <p className="empty-state">暂无待办，可以让 Agent 帮你创建。</p>
              )}
              <p className="list-help">
                待办关联来源便签，方便核对原话和执行结果。
              </p>
            </section>
          )}
        </main>
      )}
      <nav className="bottom-nav" aria-label="底部菜单">
        <button
          className={`nav-item ${screen === "agent" ? "active" : ""}`}
          aria-current={screen === "agent" ? "page" : undefined}
          onClick={() => setScreen("agent")}
        >
          <Image
            src="/art/agent.png"
            width={33}
            height={33}
            alt=""
            className="pixel-art"
          />
          <span>Agent</span>
        </button>
        <button
          className="nav-item voice-nav"
          aria-label="打开语音录音浮窗"
          onClick={openVoice}
        >
          <Image
            src="/art/microphone.png"
            width={72}
            height={48}
            alt=""
            className="pixel-art"
          />
          <span>语音</span>
        </button>
        <button
          className={`nav-item ${screen === "mine" ? "active" : ""}`}
          aria-current={screen === "mine" ? "page" : undefined}
          onClick={() => setScreen("mine")}
        >
          <Image
            src="/art/profile.png"
            width={33}
            height={33}
            alt=""
            className="pixel-art"
          />
          <span>我的</span>
        </button>
      </nav>
      <dialog
        ref={voiceDialog}
        className="bottom-sheet voice-sheet"
        aria-labelledby="voice-title"
        onClose={() => recorder.stop()}
        onCancel={() => recorder.stop()}
        onClick={(e) => {
          if (e.target === e.currentTarget) closeVoice();
        }}
      >
        <div className="sheet-body">
          <div className="sheet-handle" />
          <div className="sheet-header">
            <div>
              <h2 id="voice-title">语音记录</h2>
              <p>说下想记住的事，或要办的事。</p>
            </div>
            <button
              className="close-button"
              onClick={closeVoice}
              aria-label="关闭语音浮窗"
            >
              <UiIcon name="close" />
            </button>
          </div>
          <div className="voice-tabs" role="group" aria-label="记录方式">
            <button
              aria-pressed={voiceMode === "audio"}
              className={voiceMode === "audio" ? "active" : ""}
              onClick={() => setVoiceMode("audio")}
            >
              录音
            </button>
            <button
              aria-pressed={voiceMode === "text"}
              className={voiceMode === "text" ? "active" : ""}
              onClick={openText}
            >
              文字
            </button>
          </div>
          {voiceMode === "audio" ? (
            <>
              <div
                className={`recording-area ${recording ? "is-recording" : ""}`}
              >
                <div className="recording-status" role="status">
                  <i />
                  {recording
                    ? "正在录音"
                    : recorder.recovering
                      ? "正在恢复本机录音"
                      : recorder.asrStatus === "connecting"
                        ? "连接语音识别中"
                        : recorder.status === "requesting"
                          ? "正在请求麦克风权限"
                          : recorder.status === "finishing"
                            ? "正在完成录音与转写"
                            : recorder.status === "recorded"
                              ? "录音已完成"
                              : "准备录音"}
                </div>
                <div className="recording-clock">
                  {clock(recorder.duration)}
                </div>
                <div className="waveform" aria-hidden="true">
                  {Array.from({ length: 25 }, (_, i) => (
                    <span
                      key={i}
                      style={
                        {
                          "--bar-height": `${[10, 18, 26, 15, 34, 23, 42, 28, 16, 35, 48, 30, 55, 34, 44, 22, 36, 19, 29, 16, 39, 24, 15, 21, 9][i]}px`,
                          "--bar-delay": `${(i % 7) * -0.13}s`,
                        } as React.CSSProperties
                      }
                    />
                  ))}
                </div>
                {recorder.error && (
                  <p className="recording-error" role="alert">
                    {recorder.error}
                  </p>
                )}
                {recorder.audioUrl &&
                (recorder.status === "recorded" ||
                  recorder.status === "finishing") ? (
                  <div className="audio-review">
                    <audio
                      controls
                      src={recorder.audioUrl}
                      aria-label="录音试听"
                    />
                    <div>
                      <button
                        disabled={busy || waiting}
                        onClick={() => {
                          startRecording();
                        }}
                      >
                        重新录制
                      </button>
                      <a
                        href={recorder.audioUrl}
                        download={`nota-recording.${recorder.audioBlob?.type.includes("mp4") ? "m4a" : "webm"}`}
                      >
                        保存录音
                      </a>
                    </div>
                  </div>
                ) : (
                  <button
                    className={`record-control ${recording ? "stop-control" : ""}`}
                    disabled={waiting || busy || recorder.recovering}
                    aria-label={
                      recording
                        ? "停止录音"
                        : recorder.status === "requesting"
                          ? "等待麦克风授权"
                          : "开始录音"
                    }
                    onClick={() =>
                      recording ? recorder.stop() : startRecording()
                    }
                  >
                    {recording ? (
                      <span className="stop-square" />
                    ) : (
                      <Image
                        src="/art/microphone.png"
                        width={120}
                        height={80}
                        alt=""
                        className="pixel-art"
                      />
                    )}
                  </button>
                )}
                <span className="record-action-label">
                  {recording
                    ? "点击结束录音 · 最长60秒"
                    : waiting
                      ? "请稍候…"
                      : recorder.status === "recorded"
                        ? "可以先试听，确认没有遗漏"
                        : "点击开始录音"}
                </span>
              </div>
              <div className="transcription-status">
                <span>
                  {user && config.asr
                    ? config.websocket_environment
                      ? "实时转写"
                      : "录音后转写（本地环境）"
                    : "本机录音"}
                </span>
                <p>
                  {recorder.transcript ||
                    recorder.asrError ||
                    (!user
                      ? "登录后可转写、保存原音并整理。"
                      : !config.asr
                        ? "语音模型尚未配置，仍可保存录音或手动输入。"
                        : recording
                          ? "正在听你说话…"
                          : "转写完成后可编辑文字，再确认整理。")}
                </p>
              </div>
              {recorder.audioBlob && !recording && (
                <>
                  {recorder.recovered && (
                    <p className="text-draft-help">
                      已恢复本机录音，可试听、重新转写或继续整理。
                    </p>
                  )}
                  <p className="text-draft-help" role="status">
                    {recorder.durabilityError ||
                      "原音已暂存本机，刷新后可继续；清理浏览器数据会删除本机副本。"}
                  </p>
                  <div className="voice-text-actions">
                    <button
                      className="draft-save"
                      disabled={busy || waiting || !user || !config.asr}
                      onClick={() => {
                        manualEdit.current = false;
                        void recorder.retryTranscription();
                      }}
                    >
                      重新转写原音
                    </button>
                    <button
                      className="draft-save"
                      disabled={busy || !user}
                      onClick={() => void saveOriginalOnly()}
                    >
                      保存原音到云端
                    </button>
                  </div>
                  <button
                    className="wide-button"
                    disabled={waiting}
                    onClick={openText}
                  >
                    确认文字并整理 →
                  </button>
                  {draftNotice && (
                    <p className="draft-notice" role="status">
                      {draftNotice}
                    </p>
                  )}
                </>
              )}
              <button className="switch-to-text" onClick={openText}>
                也可以改用文字记录 →
              </button>
            </>
          ) : (
            <div className="voice-text">
              <label htmlFor="voice-draft">确认要记录的内容</label>
              <textarea
                id="voice-draft"
                value={draft}
                onChange={(e) => {
                  manualEdit.current = true;
                  setEditedDraft(e.target.value);
                  recorder.saveTranscript(e.target.value);
                  setDraftNotice("");
                }}
                maxLength={10000}
                placeholder="输入要整理的话，或先记下一件待办…"
              />
              <span className="text-count">{draft.length} / 10000</span>
              <div className="voice-text-actions">
                <button className="draft-save" onClick={saveDraft}>
                  保存草稿
                </button>
                <button
                  className="wide-button"
                  disabled={busy || waiting || recording || !draft.trim()}
                  onClick={() => void submitJob("note", draft)}
                >
                  {busy ? "正在处理…" : "保存并整理"}
                </button>
              </div>
              {recorder.audioBlob && (
                <>
                  <p className="text-draft-help">
                    默认会私有保存原始录音，再处理确认后的文字。
                  </p>
                  <button
                    className="switch-to-text"
                    disabled={busy}
                    onClick={() => void submitJob("note", draft, false)}
                  >
                    仅整理文字，不保存原音
                  </button>
                </>
              )}
              <p className="draft-notice" role="status">
                {draftNotice}
              </p>
              {storedDraft && (
                <button
                  className="draft-delete"
                  disabled={busy || waiting || recording}
                  onClick={removeDraft}
                >
                  删除本机草稿
                </button>
              )}
              {voiceNoteId && (
                <p className="text-draft-help">
                  云端草稿已建立，失败后重试会沿用原记录。
                </p>
              )}
              {activeJob?.kind === "note" && (
                <div className="voice-job-progress">
                  <p>
                    {activeJob.status === "failed"
                      ? activeJob.error
                      : activeJob.status === "succeeded"
                        ? "整理完成"
                        : "正在整理，可关闭浮窗稍后查看。"}
                  </p>
                  {!busy && activeJob.status !== "succeeded" && user && (
                    <button
                      className="source-link"
                      onClick={() => void watchJob(activeJob.id, user)}
                    >
                      重试 / 继续查看原任务 →
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </dialog>
      <dialog
        ref={sourceDialog}
        className="bottom-sheet note-sheet"
        aria-labelledby="note-title"
        onClick={(e) => {
          if (e.target === e.currentTarget) sourceDialog.current?.close();
        }}
      >
        <div className="sheet-body">
          <div className="sheet-handle" />
          <div className="sheet-header">
            <span className="sample-label">
              {noteIsReal ? "便签详情" : "便签详情 · 示例"}
            </span>
            <button
              className="close-button"
              onClick={() => sourceDialog.current?.close()}
              aria-label="关闭便签详情"
            >
              <UiIcon name="close" />
            </button>
          </div>
          <h2 id="note-title">{note.title}</h2>
          <p className="detail-meta">
            {noteIsReal
              ? date((note as Note).recorded_at ?? (note as Note).created_at)
              : (note as DemoNote).time}
          </p>
          {noteIsReal && (note as Note).has_audio && (
            <audio
              className="stored-audio"
              controls
              src={`/api/notes/${note.id}/audio`}
              aria-label="原始录音"
            />
          )}
          <section>
            <h3>摘要</h3>
            <MarkdownMessage>{note.summary || "尚未整理。"}</MarkdownMessage>
          </section>
          <section>
            <h3>转写原文</h3>
            <p>{note.transcript || "尚未确认文字。"}</p>
          </section>
          {noteIsReal
            ? (note as NoteDetail).todos?.map((todo) => (
                <div className="message-task" key={todo.id}>
                  <span>
                    <UiIcon name="check" />
                  </span>
                  <div>
                    <strong>{todo.title}</strong>
                    <small>{date(todo.due_at)}</small>
                  </div>
                </div>
              ))
            : (note as DemoNote).task && (
                <div className="message-task">
                  <span>
                    <UiIcon name="check" />
                  </span>
                  <div>
                    <strong>{(note as DemoNote).task}</strong>
                    <small>2026/11/13 15:00 · 示例</small>
                  </div>
                </div>
              )}
          {noteIsReal && (note as Note).status === "draft" && (
            <button
              className="wide-button"
              onClick={() => {
                const saved = note as Note;
                if (
                  recorder.audioBlob &&
                  recorder.audioId !== saved.id &&
                  !window.confirm(
                    "打开这条云端录音会替换当前本机录音，继续吗？",
                  )
                )
                  return;
                recorder.discard(false);
                if (user) clearOperation(user.id, "note");
                manualEdit.current = true;
                setEditedDraft(saved.transcript);
                setVoiceNoteId(saved.id);
                sourceDialog.current?.close();
                setVoiceMode(saved.has_audio ? "audio" : "text");
                setDraftNotice("已恢复云端草稿，已保存的原始录音会保留。");
                voiceDialog.current?.showModal();
                if (saved.has_audio) {
                  void fetch(`/api/notes/${saved.id}/audio`)
                    .then(async (response) => {
                      if (!response.ok)
                        throw new Error("云端原音读取失败，请稍后重试。");
                      const blob = await response.blob();
                      if (!user || ownerRef.current?.id !== user.id) return;
                      await recorder.restoreAudio(blob, {
                        id: saved.id,
                        transcript: saved.transcript,
                        recorded_at: saved.recorded_at ?? saved.created_at,
                        duration_seconds: saved.duration_seconds ?? 0,
                      });
                    })
                    .catch((error) => setDraftNotice(message(error)));
                }
              }}
            >
              继续整理此便签
            </button>
          )}
          {noteIsReal && (note as NoteDetail).job?.status === "failed" && (
            <button
              className="wide-button"
              onClick={() => {
                sourceDialog.current?.close();
                if (user) void watchJob((note as NoteDetail).job!.id, user);
              }}
            >
              重试原任务
            </button>
          )}
          {noteIsReal && (
            <button className="delete-note" onClick={() => void removeNote()}>
              删除便签及关联待办
            </button>
          )}
        </div>
      </dialog>
      <dialog
        ref={authDialog}
        className="bottom-sheet auth-sheet"
        aria-labelledby="auth-title"
        onClick={(e) => {
          if (e.target === e.currentTarget && !authBusy)
            authDialog.current?.close();
        }}
      >
        <div className="sheet-body">
          <div className="sheet-handle" />
          <div className="sheet-header">
            <div>
              <h2 id="auth-title">
                {authMode === "login" ? "登录 Nota" : "创建账户"}
              </h2>
              <p>保存你的便签、待办和每日额度。</p>
            </div>
            <button
              className="close-button"
              disabled={authBusy}
              onClick={() => authDialog.current?.close()}
              aria-label="关闭登录浮窗"
            >
              <UiIcon name="close" />
            </button>
          </div>
          <form className="auth-form" onSubmit={submitAuth}>
            <label>
              邮箱
              <input
                type="email"
                required
                maxLength={254}
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label>
              密码
              <input
                type="password"
                required
                minLength={8}
                maxLength={128}
                autoComplete={
                  authMode === "login" ? "current-password" : "new-password"
                }
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <p className="text-draft-help">密码至少8位。</p>
            {authError && (
              <p className="recording-error" role="alert">
                {authError}
              </p>
            )}
            <button className="wide-button" disabled={authBusy}>
              {authBusy
                ? "请稍候…"
                : authMode === "login"
                  ? "登录"
                  : "注册并登录"}
            </button>
          </form>
          <button
            className="switch-to-text"
            disabled={authBusy}
            onClick={() => {
              setAuthMode(authMode === "login" ? "register" : "login");
              setAuthError("");
            }}
          >
            {authMode === "login" ? "还没有账户？注册 →" : "已有账户？登录 →"}
          </button>
          {!config.database && (
            <p className="text-draft-help">
              数据库尚未配置，账户服务暂不可用。
            </p>
          )}
        </div>
      </dialog>
    </div>
  );
}

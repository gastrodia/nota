import { z } from "zod";
export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(128),
});
export const jobInputSchema = z.object({
  kind: z.enum(["note", "chat"]),
  input: z.string().trim().min(1).max(10000),
  note_id: z.string().uuid().optional(),
  conversation_id: z.string().uuid().optional(),
  idempotency_key: z.string().uuid(),
});
export const createTodoSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    due_at: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();
export const searchNotesSchema = z
  .object({
    query: z.string().trim().max(300),
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
  })
  .strict();
export const agentResultSchema = z
  .object({
    title: z.string().max(120),
    summary: z.string().max(4000),
    answer: z.string().max(8000),
    source_note_ids: z.array(z.string().uuid()).max(20),
  })
  .strict();
export type AgentResult = z.infer<typeof agentResultSchema> & {
  needs_clarification?: boolean;
  todos: Todo[];
  sources: Evidence[];
};
export interface User {
  id: string;
  email: string;
}
export interface Note {
  id: string;
  title: string;
  transcript: string;
  summary: string;
  status: "draft" | "processing" | "ready" | "failed";
  source: string;
  created_at: string;
  recorded_at?: string;
  duration_seconds: number | null;
  has_audio: boolean;
}
export interface Todo {
  id: string;
  title: string;
  due_at: string | null;
  completed: boolean;
  note_id: string | null;
  source_text: string;
  created_at: string;
}
export interface Evidence {
  id: string;
  title: string;
  transcript: string;
  created_at: string;
  recorded_at?: string;
  excerpt_truncated?: boolean;
}
export interface JobEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}
export interface PublicJob {
  id: string;
  kind: "note" | "chat";
  input: string;
  conversation_id: string | null;
  note_id: string | null;
  status: "pending" | "running" | "succeeded" | "failed";
  attempt: number;
  result: AgentResult | null;
  error: string | null;
  events: JobEvent[];
  lease_until: string | null;
  created_at: string;
}
export interface Quota {
  day: string;
  used: number;
  limit: 10;
  remaining: number;
  timezone: string;
}
export interface AppStatus {
  test_mode?: boolean;
  database: boolean;
  model: boolean;
  audio_storage: boolean;
  asr: boolean;
  websocket_environment: boolean;
}

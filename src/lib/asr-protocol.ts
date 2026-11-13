export class TranscriptAccumulator {
  private items = new Map<string, { text: string; final: boolean }>();
  apply(event: Record<string, unknown>) {
    const type = String(event.type ?? "");
    const id =
      typeof event.item_id === "string"
        ? event.item_id
        : typeof (event.item as Record<string, unknown> | undefined)?.id ===
            "string"
          ? String((event.item as Record<string, unknown>).id)
          : "";
    if (id && !this.items.has(id))
      this.items.set(id, { text: "", final: false });
    if (type === "conversation.item.input_audio_transcription.text" && id)
      this.items.set(id, {
        text: String(event.text ?? "") + String(event.stash ?? ""),
        final: false,
      });
    if (type === "conversation.item.input_audio_transcription.completed" && id)
      this.items.set(id, { text: String(event.transcript ?? ""), final: true });
    if (
      type === "conversation.item.input_audio_transcription.failed" ||
      type === "error"
    )
      throw new Error("asr_provider_error");
    const text = [...this.items.values()]
      .map((v) => v.text)
      .filter(Boolean)
      .join("\n");
    if (text.length > 10000) throw new Error("transcript_too_long");
    const finished = type === "session.finished";
    if (finished && [...this.items.values()].some((v) => v.text && !v.final))
      throw new Error("asr_incomplete_transcript");
    return { text, finished };
  }
}

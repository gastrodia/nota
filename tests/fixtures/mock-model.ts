import { createServer } from "node:http";

// Protocol fixture only: deterministic tool selection, never a real model evaluation.
export function createMockModel() {
  const failOnce = new Set<string>();
  const provider = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const first =
      body.messages
        .filter(
          (m: { role: string; content: string }) =>
            m.role === "user" && !m.content.startsWith("现在只输出最终JSON"),
        )
        .at(-1)?.content ?? "";
    const tools = body.messages
      .filter((m: { role: string }) => m.role === "tool")
      .map((m: { content: string }) => JSON.parse(m.content));
    const failureKey = first + (body.response_format ? ":final" : ":tool");
    if (
      (first.includes("fail-before") && !body.response_format) ||
      (first.includes("fail-after") &&
        body.response_format?.json_schema?.name === "nota_result")
    ) {
      if (!failOnce.has(failureKey)) {
        failOnce.add(failureKey);
        res.writeHead(503);
        res.end("{}");
        return;
      }
    }
    let message;
    if (body.response_format?.json_schema?.name === "nota_todo_authorization") {
      const input = JSON.parse(first);
      message = {
        role: "assistant",
        content: JSON.stringify({
          authorized: !input.user_input.includes("不要"),
          reason: "Protocol fixture",
        }),
      };
    } else if (body.response_format) {
      const todos = tools.flatMap((r: { todo?: unknown }) =>
        r.todo ? [r.todo] : [],
      );
      const sources = tools.flatMap(
        (r: { sources?: { id: string }[] }) => r.sources ?? [],
      );
      message = {
        role: "assistant",
        content: JSON.stringify({
          title: "处理结果",
          summary: first.slice(0, 200),
          answer: todos.length
            ? "已创建待办。"
            : sources.length
              ? "报价为8万元。"
              : "已整理。",
          source_note_ids: sources.map((s: { id: string }) => s.id),
        }),
      };
    } else if (!tools.length && first.includes("查询"))
      message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_search",
            type: "function",
            function: {
              name: "search_notes",
              arguments: JSON.stringify({
                query: "报价",
                start_date: null,
                end_date: null,
              }),
            },
          },
        ],
      };
    else if (
      !tools.length &&
      (first.includes("创建") || first.includes("fail-"))
    )
      message = {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_create",
            type: "function",
            function: {
              name: "create_todo",
              arguments: JSON.stringify({
                title: "发送报价单",
                due_at: "2026-11-14T15:00:00+08:00",
              }),
            },
          },
        ],
      };
    else message = { role: "assistant", content: "已处理" };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message }] }));
  });

  return provider;
}

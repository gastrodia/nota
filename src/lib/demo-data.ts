export const demoNotes = [
  {
    id: "quote",
    title: "客户方案与报价确认",
    time: "2026/11/12 14:32",
    duration: "28 秒",
    summary:
      "基础版报价 8 万元，客户希望下周看到第一版方案。明天下午 3 点发送报价单。",
    transcript:
      "今天和客户确认了，基础版报价八万元，客户希望下周看到第一版方案。帮我创建一个待办，明天下午三点把报价单发过去。",
    task: "发送报价单",
  },
  {
    id: "idea",
    title: "产品讨论中的一个想法",
    time: "2026/11/12 10:16",
    duration: "15 秒",
    summary:
      "收集通勤时的零碎想法，每周集中回顾。本条只记录想法，没有创建待办。",
    transcript:
      "通勤时经常想到一些点子，过一会儿就忘了。也许可以把它们收集起来，每周回顾一下，先记下这个想法。",
    task: null,
  },
  {
    id: "meeting",
    title: "项目评审结论",
    time: "2026/11/11 16:40",
    duration: "32 秒",
    summary:
      "首版优先完成文字录入、摘要和待办。语音联调安排在下次评审，时间待确认。",
    transcript:
      "今天评审确定，首版先完成文字录入、摘要和待办。语音识别留到下次评审联调，时间还没定。先保存会议结论，不需要建待办。",
    task: null,
  },
];

export type DemoNote = (typeof demoNotes)[number];

import test from "node:test";
import assert from "node:assert/strict";
import { hasUnsupportedReminderPromise } from "../scripts/lib/evaluation";
test("reminder evaluation flags positive promises", () => {
  for (const text of [
    "届时会提醒您。",
    "到时会自动提醒你。",
    "我会在截止时间提醒你。",
    "会自动发送通知。",
  ])
    assert.equal(hasUnsupportedReminderPromise(text), true, text);
});
test("reminder evaluation accepts explicit lack of notification capability", () => {
  for (const text of [
    "届时不会自动提醒你，请留意待办列表。",
    "我不会自动提醒。",
    "系统不支持定时推送通知。",
    "目前没有提醒功能。",
    "已保存到待办列表。",
  ])
    assert.equal(hasUnsupportedReminderPromise(text), false, text);
});

// Detect explicit promises while excluding “不会自动提醒”等否定表达。
export function hasUnsupportedReminderPromise(answer: string) {
  return /(?<!不)(?:我会|我将|会自动|将会|届时会|到时会|到时将).{0,12}(?:提醒|通知)/.test(
    answer,
  );
}

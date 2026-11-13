import type { Evidence } from "../lib/contracts";

// Deliberately bounded lexical expansion, not semantic embeddings. Each query
// term remains mandatory, so expanding “价格” never discards “海星 / ZX999”.
const synonymGroups = [
  ["报价", "价格", "售价", "价钱", "多少钱"],
  ["交付周期", "交付时间", "交货周期", "交货时间", "工期"],
  ["会议纪要", "会议记录", "开会记录"],
  ["截止时间", "截止日期", "最后期限"],
] as const;

export function retrievalTerms(query: string): string[][] {
  const terms = query
    .normalize("NFKC")
    .split(/[\s,，、；;]+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 8);
  return [...new Set(terms)].map((term) => {
    const variants = new Set([term]);
    for (const group of synonymGroups) {
      const matched = group.find((word) => term.includes(word));
      if (matched)
        for (const word of group) variants.add(term.replace(matched, word));
    }
    return [...variants];
  });
}

export function retrievalPatterns(terms: string[][]) {
  return terms.map((variants) =>
    variants.map((term) => "%" + term.replace(/[\\%_]/g, "\\$&") + "%"),
  );
}

export function evidenceExcerpt(row: Evidence, terms: string[][]): Evidence {
  const text = row.transcript;
  if (text.length <= 2500) return { ...row, excerpt_truncated: false };
  const starts = new Set([0]);
  for (const term of terms.flat()) {
    let at = text.indexOf(term);
    let count = 0;
    while (at >= 0 && count++ < 20) {
      starts.add(Math.max(0, at - 300));
      at = text.indexOf(term, at + term.length);
    }
  }
  const score = (start: number) => {
    const window = text.slice(start, start + 2500);
    return terms.filter((variants) =>
      variants.some((term) => window.includes(term)),
    ).length;
  };
  const start = [...starts].sort((a, b) => score(b) - score(a) || a - b)[0];
  return {
    ...row,
    transcript: text.slice(start, start + 2500),
    excerpt_truncated: true,
  };
}

function monetaryNumber(text: string) {
  const arabic = /^(\d+(?:\.\d+)?)([亿万千百])?$/.exec(text);
  const units: Record<string, number> = {
    十: 10,
    百: 100,
    千: 1000,
    万: 10000,
    亿: 100000000,
  };
  if (arabic) return Number(arabic[1]) * (units[arabic[2]] ?? 1);
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const char of text) {
    if (char in digits) digit = digits[char];
    else if (units[char] < 10000) {
      section += (digit || 1) * units[char];
      digit = 0;
    } else if (char === "万") {
      section = (section + digit) * 10000;
      digit = 0;
    } else if (char === "亿") {
      total += (section + digit) * 100000000;
      section = 0;
      digit = 0;
    }
  }
  return total + section + digit;
}

function monetaryFacts(text: string): string[] {
  const values = [
    ...text
      .normalize("NFKC")
      .matchAll(
        /((?:\d+(?:\.\d+)?|[一二两三四五六七八九十百千万亿零〇]+)\s*(?:亿|万|千|百)?)\s*(美元|美金|人民币|块钱|块|元)/g,
      ),
  ];
  return [
    ...new Set(
      values.map(
        (value) =>
          `${/美元|美金/.test(value[2]) ? "USD" : "CNY"}:${monetaryNumber(value[1].replace(/\s/g, ""))}`,
      ),
    ),
  ].sort();
}

export function quotationAmbiguity(query: string, sources: Evidence[]) {
  if (!/报价|价格|售价|价钱|多少钱/.test(query)) return false;
  const facts = sources
    .map((source) => monetaryFacts(source.transcript))
    .filter((values) => values.length);
  // Several records may repeat the same quote. Ask only when actual monetary
  // evidence differs; never silently assume the latest record is the answer.
  return (
    facts.length > 1 &&
    new Set(facts.map((values) => values.join("|"))).size > 1
  );
}

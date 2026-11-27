// 辞書の候補のまとめ方のテスト。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeSuggestions } from "../src/worker/terms.ts";

test("同じ表記の候補は 1 つにまとめ、読みと誤認識と理由を合わせる", () => {
  const merged = mergeSuggestions([
    { written: "型", readings: ["かた"], source: "登壇の書き起こし", heard: "肩", reason: "型システムの話の流れから。" },
    { written: "遅延", readings: ["ちえん"], source: "登壇の書き起こし", heard: "支援", reason: "結果として落ち着くのは遅延。" },
    { written: "型", readings: ["かた", "がた"], source: "登壇の書き起こし", heard: "方", reason: "Send の説明が続くので。" },
    { written: "型", readings: ["かた"], source: "登壇の書き起こし", heard: "肩", reason: "" },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], {
    written: "型",
    readings: ["かた", "がた"],
    source: "登壇の書き起こし",
    heard: "肩」「方",
    reason: "型システムの話の流れから。 Send の説明が続くので。",
  });
  assert.equal(merged[1]?.written, "遅延");
});

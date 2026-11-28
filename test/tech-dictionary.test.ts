import assert from "node:assert/strict";
import { test } from "node:test";
import { TECH_SOURCE, withTechTerms, type TechTerm } from "../src/shared/tech-dictionary.ts";

const tech: TechTerm[] = [
  { written: "MCP Server", readings: ["えむしーぴーさーばー"], df: 10, kind: "技術概念" },
  { written: "TypeScript", readings: ["たいぷすくりぷと"], df: 300, kind: "言語" },
  { written: "Tokio", readings: ["ときお", "とーきお"], df: 5, kind: "フレームワーク・ライブラリ" },
  { written: "Hono", readings: ["ほの"], df: 40, kind: "フレームワーク・ライブラリ" },
];

test("ルームの辞書を先に置き、技術用語の辞書を後ろに重ねる", () => {
  const merged = withTechTerms([{ written: "Durable Objects", readings: ["でゅらぶるおぶじぇくつ"], source: "p.2" }], tech);
  assert.equal(merged[0]?.written, "Durable Objects");
  assert.deepEqual(
    merged.slice(1).map((t) => t.written),
    ["MCP Server", "TypeScript", "Tokio", "Hono"],
  );
  assert.equal(merged[1]?.source, TECH_SOURCE);
});

test("ルームの辞書と同じ表記の語は、大文字・小文字や空白が違っても入れない", () => {
  const merged = withTechTerms([{ written: "typescript", readings: ["てぃーえす"] }], tech);
  assert.ok(!merged.some((t) => t.written === "TypeScript"));
});

test("ルームの辞書の語と同じ読みは使わず、読みが残らない語は入れない", () => {
  const merged = withTechTerms(
    [
      { written: "MCP サーバー", readings: ["えむしーぴーさーばー"] },
      { written: "時男", readings: ["トキオ"] },
    ],
    tech,
  );
  assert.ok(!merged.some((t) => t.written === "MCP Server"));
  assert.deepEqual(merged.find((t) => t.written === "Tokio")?.readings, ["とーきお"]);
});

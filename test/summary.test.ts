import { test } from "node:test";
import assert from "node:assert/strict";
import { layerRows } from "../src/shared/diagram-layout.ts";
import { normalizeSummary } from "../src/worker/summary.ts";
import { SUMMARY_LIMITS } from "../src/shared/protocol.ts";

type Diagram = Parameters<typeof layerRows>[0];

function diagram(nodes: string[], edges: [string, string][]): Diagram {
  return {
    title: "",
    focus: "",
    nodes: nodes.map((id) => ({ id, label: id, kind: "concept" })),
    edges: edges.map(([from, to]) => ({ from, to, label: "" })),
  };
}

test("layerRows: 矢印の元から先へ段が深くなる", () => {
  const rows = layerRows(diagram(["cause", "problem", "fix"], [["cause", "problem"], ["problem", "fix"]]));
  assert.deepEqual(rows, [["cause"], ["problem"], ["fix"]]);
});

test("layerRows: 出るだけの節は、つながる先のすぐ上の段まで下げる", () => {
  // tool は fix にだけつながる。最長経路のままだと 0 段目に置かれ、矢印が 2 段を横切る
  const rows = layerRows(diagram(["cause", "problem", "fix", "tool"], [["cause", "problem"], ["problem", "fix"], ["tool", "fix"]]));
  assert.deepEqual(rows[1]?.sort(), ["problem", "tool"]);
  assert.deepEqual(rows[2], ["fix"]);
});

test("layerRows: 循環があっても止まり、すべての節を一度ずつ置く", () => {
  const rows = layerRows(diagram(["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "a"]]));
  assert.deepEqual(rows.flat().sort(), ["a", "b", "c"]);
});

test("layerRows: どの矢印にもつながらない節は最後の段にまとめる", () => {
  const rows = layerRows(diagram(["a", "b", "lonely"], [["a", "b"]]));
  assert.deepEqual(rows.at(-1), ["lonely"]);
});

test("layerRows: 段の中は、上の段のつながる節の位置に合わせて並べる", () => {
  // 上の段が [left, right] なら、right の子は右に来る
  const rows = layerRows(diagram(["left", "right", "rightChild", "leftChild"], [["left", "leftChild"], ["right", "rightChild"]]));
  assert.deepEqual(rows[0], ["left", "right"]);
  assert.deepEqual(rows[1], ["leftChild", "rightChild"]);
});

test("normalizeSummary: 存在しない節への矢印・重複・自己ループを落とし、時刻を読み、上限に収める", () => {
  const nodes = Array.from({ length: SUMMARY_LIMITS.nodes + 3 }, (_, i) => ({ id: `N${i}`, label: `節${i}`, kind: "tool" as const }));
  const s = normalizeSummary({
    topic: "テーマ",
    now: "いまの話",
    sections: [{ title: "導入", start: "01:05", points: ["要点"] }],
    diagram: {
      title: "図",
      nodes: [...nodes, { id: "n0", label: "重複", kind: "tool" }],
      edges: [
        { from: "N0", to: "N1", label: "関係" },
        { from: "n0", to: "n1", label: "重複" },
        { from: "N2", to: "N2", label: "自己" },
        { from: "N0", to: "missing", label: "" },
      ],
      focus: "N1",
    },
    terms: [{ term: "RAG", note: "検索した文書を渡して回答させる手法" }, { term: "", note: "空" }],
    qa: [],
  });
  assert.equal(s.diagram.nodes.length, SUMMARY_LIMITS.nodes);
  assert.equal(s.diagram.nodes[0]!.id, "n0");
  assert.deepEqual(s.diagram.edges, [{ from: "n0", to: "n1", label: "関係" }]);
  assert.equal(s.diagram.focus, "n1");
  assert.equal(s.sections[0]!.startMs, 65_000);
  assert.deepEqual(s.terms.map((t) => t.term), ["RAG"]);
});

test("normalizeSummary: 長すぎる語句は省略記号で切る", () => {
  const s = normalizeSummary({
    topic: "あ".repeat(100),
    now: "",
    sections: [],
    diagram: { title: "", nodes: [{ id: "a", label: "い".repeat(60), kind: "point" }], edges: [], focus: "" },
    terms: [],
    qa: [],
  });
  assert.ok(s.topic.endsWith("…"));
  assert.ok(s.topic.length <= SUMMARY_LIMITS.topic + 6);
  assert.ok(s.diagram.nodes[0]!.label.length <= SUMMARY_LIMITS.nodeLabel + 8);
});

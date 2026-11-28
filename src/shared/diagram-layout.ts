// 「ここまでのまとめ」の図の段組み。画面の描画（src/client/summary.ts）から使い、DOM には触れない。

import type { LiveSummary } from "./protocol.ts";

type Diagram = LiveSummary["diagram"];

/**
 * 節を段に分ける。矢印の元から先へ深くなるよう、最長経路で段を決める（循環は DFS で戻る辺を無視して切る）。
 * 段の中の並びは、上の段でつながっている節の位置の平均（重心）で並べ替えて、矢印の交差を減らす。
 * どの矢印にもつながらない節は最後の段にまとめる。
 */
export function layerRows(d: Diagram): string[][] {
  const ids = d.nodes.map((n) => n.id);
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of d.edges) out.get(e.from)?.push(e.to);
  const state = new Map<string, 1 | 2>();
  const dag: [string, string][] = [];
  const visit = (id: string): void => {
    state.set(id, 1);
    for (const to of out.get(id) ?? []) {
      const s = state.get(to);
      if (s === 1) continue; // 戻る辺（循環）
      dag.push([id, to]);
      if (s === undefined) visit(to);
    }
    state.set(id, 2);
  };
  const hasIn = new Set(d.edges.map((e) => e.to));
  for (const id of ids) if (!hasIn.has(id) && !state.has(id)) visit(id);
  for (const id of ids) if (!state.has(id)) visit(id);

  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  // 段の数は節の数を超えないので、その回数だけ緩和すれば収束する
  for (let i = 0; i < ids.length; i++) {
    let changed = false;
    for (const [from, to] of dag) {
      const next = layer.get(from)! + 1;
      if (next > layer.get(to)!) {
        layer.set(to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // 出るだけの節（背景や道具に多い）は、つながる先のすぐ上の段まで下げる。長い矢印が途中の段を横切るのを減らす
  const hasPred = new Set(dag.map(([, to]) => to));
  for (const id of ids) {
    if (hasPred.has(id)) continue;
    const below = dag.filter(([from]) => from === id).map(([, to]) => layer.get(to)!);
    if (below.length > 0) layer.set(id, Math.max(layer.get(id)!, Math.min(...below) - 1));
  }
  const connected = new Set(d.edges.flatMap((e) => [e.from, e.to]));
  const depth = Math.max(0, ...ids.filter((id) => connected.has(id)).map((id) => layer.get(id)!));
  const rows: string[][] = Array.from({ length: depth + 1 }, () => []);
  const loose: string[] = [];
  for (const id of ids) {
    if (!connected.has(id)) loose.push(id);
    else rows[layer.get(id)!]!.push(id);
  }
  // 重心で並べ替える（下向きに 2 回、上向きに 1 回）
  const position = new Map<string, number>();
  const index = () => rows.forEach((row) => row.forEach((id, i) => position.set(id, row.length > 1 ? i / (row.length - 1) : 0.5)));
  index();
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  const succs = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [from, to] of dag) {
    preds.get(to)!.push(from);
    succs.get(from)!.push(to);
  }
  const sweep = (r: number, neighbors: Map<string, string[]>) => {
    const row = rows[r]!;
    const score = new Map(
      row.map((id, i) => {
        const ns = neighbors.get(id)!.filter((n) => position.has(n));
        return [id, ns.length > 0 ? ns.reduce((s, n) => s + position.get(n)!, 0) / ns.length : position.get(id) ?? i];
      }),
    );
    row.sort((a, b) => score.get(a)! - score.get(b)!);
    index();
  };
  for (let pass = 0; pass < 2; pass++) for (let r = 1; r < rows.length; r++) sweep(r, preds);
  for (let r = rows.length - 2; r >= 0; r--) sweep(r, succs);
  const result = rows.filter((row) => row.length > 0);
  if (loose.length > 0) result.push(loose);
  return result;
}

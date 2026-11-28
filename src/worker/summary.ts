// 配信中の登壇の「それまでの内容」を、Claude にまとめさせて図解の材料にする。
// 字幕が少したまるたびに呼び、前回のまとめを渡して書き足させる（図の節の id を保たせ、画面上で図が組み変わりすぎないようにする）。

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { DictionaryTerm } from "../shared/amivoice.ts";
import {
  DIAGRAM_KINDS,
  SUMMARY_LIMITS as L,
  type CaptionLine,
  type DiagramKind,
  type LiveSummary,
} from "../shared/protocol.ts";

/**
 * まとめに使うモデル。模擬 LT 2 本で Haiku 5.5・Sonnet 5.5・Opus 5.5 を比べると、速さはどれも 1 回 4〜10 秒だった。
 * Haiku と Opus は誤認識（「ライブラリの多くが」→「ライブラリのawkが」）を「axum」と言い換えて補ったが、Sonnet は補わなかった
 */
export const SUMMARY_MODEL = "claude-sonnet-5-5";

const SummarySchema = z.object({
  topic: z.string().describe(`この登壇のテーマを 1 行で（${L.topic} 文字以内）`),
  now: z.string().describe(`いちばん新しい字幕で登壇者が話していることを 1 文で（${L.now} 文字以内）`),
  sections: z
    .array(
      z.object({
        title: z.string().describe(`話のまとまりの見出し（${L.sectionTitle} 文字以内）`),
        start: z.string().describe("そのまとまりが始まった字幕の時刻。書き起こしの [mm:ss] をそのまま"),
        points: z.array(z.string()).describe(`そのまとまりの要点（各 ${L.point} 文字以内、${L.points} 個まで）`),
      }),
    )
    .describe(`ここまでの話の流れを、話された順に（${L.sections} 個まで）`),
  diagram: z.object({
    title: z.string().describe(`図の見出し（${L.diagramTitle} 文字以内）`),
    nodes: z
      .array(
        z.object({
          id: z.string().describe("節の id（英小文字と数字）。前回のまとめにある節は同じ id を使う"),
          label: z.string().describe(`節に書く語句（${L.nodeLabel} 文字以内）`),
          kind: z.enum(DIAGRAM_KINDS).describe("節の種類"),
        }),
      )
      .describe(`図の節（${L.nodes} 個まで）`),
    edges: z
      .array(
        z.object({
          from: z.string().describe("矢印の元の節の id"),
          to: z.string().describe("矢印の先の節の id"),
          label: z.string().describe(`矢印に添える短い語（${L.edgeLabel} 文字以内。不要なら空文字）`),
        }),
      )
      .describe(`節どうしの関係（${L.edges} 本まで）`),
    focus: z.string().describe("いま話している内容にあたる節の id（図にある節の id を必ず入れる）"),
  }),
  terms: z
    .array(
      z.object({
        term: z.string().describe("用語（字幕の綴りではなく正しい綴り）"),
        note: z.string().describe(`初めて聞く人向けの短い解説（${L.termNote} 文字以内）`),
      }),
    )
    .describe(`参加者が知らないかもしれない用語の解説（${L.terms} 個まで）`),
  qa: z
    .array(
      z.object({
        question: z.string().describe(`質問の要旨（${L.qa} 文字以内）`),
        answer: z.string().describe(`回答の要旨（${L.qa} 文字以内。まだ答えていなければ空文字）`),
      }),
    )
    .describe("質疑応答（質問が無ければ空の配列）"),
});

const SYSTEM_PROMPT = `あなたは技術勉強会・LT 会のライブ字幕に添える「ここまでのまとめ」を作る担当です。
参加者は字幕と並べてこのまとめを見て、途中から来た人や聞き逃した人も話の流れを追えるようにします。

入力:
- <transcript>: 登壇をリアルタイムに音声認識した字幕。各行の先頭は登壇の開始からの時刻 [mm:ss]。話者の区別があれば「話者1:」のように付いています。
- <dictionary>: 登壇のスライドから作った用語の一覧。字幕の誤認識を直すときの綴りの手がかりです。
- <previous>: 前回作ったまとめ（初回は無し）。字幕は前回より先まで進んでいます。

まとめ方:
- 話されたことだけを書く。字幕に無い内容を推測で補わない。これから話しそうなことも書かない。
- 字幕は音声認識なので誤認識を含む。辞書にある語と音の近い誤認識は、辞書の綴りに直す。それ以外の意味の通らない語を、別の固有名詞に置き換えて補わない（一般的な言い方にするか、書かない）。
- 前回のまとめがあれば、それを土台に書き足す。前回からある見出しや節は、字幕と食い違わない限り id と語句を保つ（画面上で図が組み変わりすぎないように）。
- 文体は体言止めか「〜する」調で短く。です・ます調にしない。
- 冒頭の挨拶だけ、のように中身がまだ少なければ、そのぶん短くてよい（節や用語は少なくてよい）。

図（diagram）:
- 登壇の論旨を、節と矢印の図にする。問題→原因→対策、道具どうしの構成、主張→根拠、のように、話の骨組みが一目で分かる形にする。
- 節の種類: concept（概念・説明）、tool（製品・ライブラリ・サービス）、problem（問題・つまずき）、cause（原因）、solution（対策・解決）、point（結論・教訓）。
- 矢印は向きに意味を持たせる（原因→問題、問題→対策、道具→使い道、全体→部分 など）。
- 話した順番に矢印でつながない（話の順番は sections に書く）。「次に」「さらに」のような順番だけの矢印を使わず、節を 1 本の鎖に並べた図にしない。1 つの問題に原因や対策が複数ぶら下がる、のように枝分かれのある図にする。
- 矢印は論旨の骨組みになる関係だけに絞る（${L.edges} 本まで）。1 つの節から出る矢印は 3 本まで。矢印の交差が少なく、上から下へ読める図にする。
- 図は登壇全体の論旨を表す。話が進んで新しい論点（問題、対策、道具、結論）が出たら、図に加える。
- 節は ${L.nodes} 個まで。上限に達していて新しい論点を加えるときは、前置きや背景の節（一般的な仕組みの説明など）をまとめるか外して空きを作る。新しい論点を図に入れないまま古い図を保つことはしない。
- focus には、いま話している内容にあたる節の id を必ず入れる。いまの話題が図に無ければ、その節を加えてから focus にする。

用語（terms）:
- 字幕に出てきた技術用語のうち、その分野に詳しくない参加者がつまずきそうなものを選び、一般的な意味を短く解説する。登壇者の主張ではなく用語そのものの説明にする。

質疑応答（qa）:
- 登壇者以外の話者からの質問と、登壇者の回答を要約する。質問が無ければ空の配列にする。`;

export interface SummaryInput {
  title: string;
  lines: CaptionLine[];
  dictionary: DictionaryTerm[];
  previous: LiveSummary | null;
  /** 話者の区別を書き起こしに入れるか（話者ダイアライゼーションを使った行があるときだけ） */
  speakers: boolean;
}

export interface SummaryResult {
  summary: Omit<LiveSummary, "talkId" | "upToLineId" | "upToMs" | "updatedAt">;
  usage: { inputTokens: number; outputTokens: number };
}

const MAX_TRANSCRIPT_CHARS = 60_000;

export async function summarizeTalk(apiKey: string, input: SummaryInput, model = SUMMARY_MODEL): Promise<SummaryResult> {
  const client = new Anthropic({ apiKey });
  let transcript = input.lines
    .map((l) => `[${clock(l.startMs)}] ${input.speakers && l.speaker !== undefined ? `話者${l.speaker + 1}: ` : ""}${l.text}`)
    .join("\n");
  // 長い登壇では古い字幕を落とす（前回のまとめにその内容が入っている）
  if (transcript.length > MAX_TRANSCRIPT_CHARS) transcript = transcript.slice(-MAX_TRANSCRIPT_CHARS).replace(/^[^\n]*\n/, "");
  const dictText = input.dictionary.length > 0 ? input.dictionary.map((t) => t.written).join("、") : "（なし）";
  const previous = input.previous ? JSON.stringify(stripMeta(input.previous)) : "（初回）";
  const response = await client.beta.messages.parse({
    model,
    max_tokens: 6000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `<title>${input.title}</title>\n<dictionary>${dictText}</dictionary>\n<previous>${previous}</previous>\n<transcript>\n${transcript}\n</transcript>`,
      },
    ],
    output_config: { format: betaZodOutputFormat(SummarySchema), effort: "low" },
  });
  if (response.stop_reason === "refusal") throw new Error("Claude がまとめを断りました");
  if (response.stop_reason === "max_tokens") throw new Error("まとめが長すぎて途中で切れました");
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("まとめを解釈できませんでした");
  const summary = normalizeSummary(parsed);
  // 「いま」の節を空のまま返すことがある。そのときは今回新しく加わった節、無ければ前回の節にする
  if (!summary.diagram.focus) {
    const before = new Set(input.previous?.diagram.nodes.map((n) => n.id) ?? []);
    const added = summary.diagram.nodes.filter((n) => !before.has(n.id)).at(-1);
    const kept = summary.diagram.nodes.find((n) => n.id === input.previous?.diagram.focus);
    summary.diagram.focus = added?.id ?? kept?.id ?? "";
  }
  return {
    summary,
    usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
  };
}

type RawSummary = z.infer<typeof SummarySchema>;

/** 文字数と個数を上限に収め、存在しない節を指す矢印を落とす。 */
export function normalizeSummary(raw: RawSummary): SummaryResult["summary"] {
  const nodes: LiveSummary["diagram"]["nodes"] = [];
  const ids = new Set<string>();
  for (const n of raw.diagram.nodes) {
    const id = n.id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24) || `n${nodes.length + 1}`;
    if (ids.has(id) || !n.label.trim()) continue;
    ids.add(id);
    nodes.push({ id, label: cut(n.label, L.nodeLabel + 8), kind: (DIAGRAM_KINDS as readonly string[]).includes(n.kind) ? (n.kind as DiagramKind) : "concept" });
    if (nodes.length >= L.nodes) break;
  }
  const seen = new Set<string>();
  const edges: LiveSummary["diagram"]["edges"] = [];
  for (const e of raw.diagram.edges) {
    const from = e.from.trim().toLowerCase();
    const to = e.to.trim().toLowerCase();
    const key = `${from}>${to}`;
    if (from === to || !ids.has(from) || !ids.has(to) || seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to, label: cut(e.label, L.edgeLabel + 2) });
    if (edges.length >= L.edges) break;
  }
  const focus = raw.diagram.focus.trim().toLowerCase();
  return {
    topic: cut(raw.topic, L.topic + 6),
    now: cut(raw.now, L.now + 10),
    sections: raw.sections.slice(0, L.sections).map((s) => ({
      title: cut(s.title, L.sectionTitle + 4),
      startMs: parseClock(s.start),
      points: s.points.map((p) => cut(p, L.point + 10)).filter(Boolean).slice(0, L.points),
    })),
    diagram: { title: cut(raw.diagram.title, L.diagramTitle + 4), nodes, edges, focus: ids.has(focus) ? focus : "" },
    terms: raw.terms
      .filter((t) => t.term.trim() && t.note.trim())
      .slice(0, L.terms)
      .map((t) => ({ term: cut(t.term, 40), note: cut(t.note, L.termNote + 10) })),
    qa: raw.qa
      .filter((q) => q.question.trim())
      .slice(0, L.qas)
      .map((q) => ({ question: cut(q.question, L.qa + 10), answer: cut(q.answer, L.qa + 10) })),
  };
}

function stripMeta(s: LiveSummary): unknown {
  const { talkId: _t, upToLineId: _l, upToMs: _m, updatedAt: _u, ...rest } = s;
  return { ...rest, sections: rest.sections.map(({ startMs, ...sec }) => ({ ...sec, start: clock(startMs) })) };
}

function cut(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function parseClock(s: string): number {
  const m = s.match(/(\d+):(\d{1,2})/);
  return m ? (Number(m[1]) * 60 + Number(m[2])) * 1000 : 0;
}

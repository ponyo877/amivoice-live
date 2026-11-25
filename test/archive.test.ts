// 話者・フィラー・信頼度・非同期 HTTP の結果・振り返りレポート・録音の分割のテスト。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProfileWords, isFillerToken, isRegistrableWritten, majorityLabel, stripFillers, type Token } from "../src/shared/amivoice.ts";
import { asyncUtterances, buildReport, speakerIndexes, type AsyncJobResult } from "../src/shared/async-result.ts";
import { buildDParam, wavHeader } from "../src/shared/async-request.ts";
import { PART_SIZE, Recording, type BucketLike, type UploadedPart } from "../src/worker/recording.ts";

test("E2E の単語強調は、強調度を指定すると代替表記を省いて「表記  強調度」にする", () => {
  const terms = [{ written: "Durable Objects", readings: [] }, { written: "Hono", readings: [] }];
  assert.equal(buildProfileWords(terms, "e2e", { emphasis: 0.8 }), "Durable_Objects  0.8|Hono  0.8");
});

test("表記に | : \" を含む語は登録しない", () => {
  assert.equal(isRegistrableWritten("C:ドライブ"), false);
  assert.equal(isRegistrableWritten("A|B"), false);
  assert.equal(isRegistrableWritten('say "hi"'), false);
  assert.equal(isRegistrableWritten("Next.js"), true);
  assert.equal(buildProfileWords([{ written: "C:ドライブ", readings: ["しーどらいぶ"] }], "hybrid"), "");
});

test("フィラーは % で囲まれた written として判定し、本文からは取り除ける", () => {
  assert.equal(isFillerToken("%えー%"), true);
  assert.equal(isFillerToken("%"), false); // 「ぱーせんと」と発話したときの % 1 文字はフィラーではない
  assert.equal(isFillerToken("100%"), false);
  assert.equal(stripFillers("%えっと%会議が%えー%あります"), "会議があります");
});

test("発話の話者はトークンの多数決で決め、ラベルの無いトークンは数えない", () => {
  const tokens: Token[] = [
    { written: "a", label: "speaker1" },
    { written: "b", label: "speaker0" },
    { written: "c", label: "speaker1" },
    { written: "d" },
  ];
  assert.equal(majorityLabel(tokens), "speaker1");
  assert.equal(majorityLabel([{ written: "x" }]), undefined);
});

test("d パラメータは値を URL エンコードして半角スペースで並べ、空の値は省く", () => {
  assert.equal(
    buildDParam({ grammarFileNames: "-a2b-ja-general", profileWords: "Durable_Objects でゅらぶる|SQL えすきゅーえる", speakerDiarization: "True", empty: "", none: undefined }),
    "grammarFileNames=-a2b-ja-general profileWords=Durable_Objects%20%E3%81%A7%E3%82%85%E3%82%89%E3%81%B6%E3%82%8B%7CSQL%20%E3%81%88%E3%81%99%E3%81%8D%E3%82%85%E3%83%BC%E3%81%88%E3%82%8B speakerDiarization=True",
  );
});

test("WAV ヘッダは 16kHz・16bit・モノラルで、データの長さを書き込む", () => {
  const h = wavHeader(32000);
  const v = new DataView(h.buffer);
  assert.equal(h.byteLength, 44);
  assert.equal(new TextDecoder().decode(h.subarray(0, 4)), "RIFF");
  assert.equal(v.getUint32(4, true), 36 + 32000);
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getUint32(40, true), 32000);
});

const result = (text: string, start: number, end: number, label?: string, extra: Partial<Token>[] = []) => ({
  results: [
    {
      text,
      starttime: start,
      endtime: end,
      tokens: [{ written: text, starttime: start, endtime: end, confidence: 0.9, label }, ...extra.map((t) => ({ written: "", ...t }))],
    },
  ],
  text,
});

test("非同期の結果は segments がトップレベルにあっても results の中にあっても読める", () => {
  const segments = [result("こんにちは", 0, 1000), result("さようなら", 2000, 3000)];
  assert.deepEqual(
    asyncUtterances({ segments }).map((u) => u.text),
    ["こんにちは", "さようなら"],
  );
  assert.deepEqual(
    asyncUtterances({ results: { segments } }).map((u) => u.text),
    ["こんにちは", "さようなら"],
  );
  assert.deepEqual(
    asyncUtterances({ results: segments[0]!.results }).map((u) => [u.text, u.startMs, u.endMs]),
    [["こんにちは", 0, 1000]],
  );
});

test("話者の番号は、いちばん長く話した人を 0 にし、ほかは初めて話した順にする（ラベルの欠番は詰める）", () => {
  const utts = asyncUtterances({
    segments: [result("質問", 0, 1000, "speaker3"), result("本題", 1000, 9000, "speaker0"), result("別の質問", 9000, 10000, "speaker5")],
  });
  const idx = speakerIndexes(utts);
  assert.equal(idx.get("speaker0"), 0);
  assert.equal(idx.get("speaker3"), 1);
  assert.equal(idx.get("speaker5"), 2);
});

test("振り返りレポート: 話す速さ・フィラー・感情・話者・自信のない語・ライブとの食い違いをまとめる", () => {
  const reportJob: AsyncJobResult = {
    segments: [
      {
        results: [
          {
            text: "%えー%今日は話します。",
            starttime: 0,
            endtime: 6000,
            tokens: [
              { written: "%えー%", spoken: "えー", starttime: 0, endtime: 500, confidence: 0.8 },
              { written: "今日は", spoken: "きょうは", starttime: 500, endtime: 2000, confidence: 0.95 },
              { written: "ハナシ", spoken: "はなし", starttime: 2000, endtime: 5000, confidence: 0.3 },
              { written: "。", starttime: 5000, endtime: 6000, confidence: 0.2 },
            ],
          },
        ],
      },
    ],
    sentiment_analysis: {
      segments: [
        { starttime: 0, endtime: 2000, energy: 40, stress: 10 },
        { starttime: 2000, endtime: 4000, energy: 60, stress: 12 },
      ],
    },
  };
  const archiveJob: AsyncJobResult = {
    segments: [result("今日は話します。", 0, 6000, "speaker1"), result("質問です。", 7000, 8000, "speaker0")],
  };
  const r = buildReport(reportJob, archiveJob, "今日は話します。質問でした。");

  // 発話の本文「今日は話します」の 7 文字（フィラーと句読点を除く）を 6 秒で話した → 70 文字/分
  assert.equal(r.charsPerMinute, 70);
  assert.equal(r.fillers.total, 1);
  assert.deepEqual(r.fillers.top, [{ word: "えー", count: 1 }]);
  assert.deepEqual(r.fillers.times, [0]);
  assert.deepEqual(r.sentiment?.keys, ["energy", "stress"]);
  assert.deepEqual(r.sentiment?.segments[1], { s: 2000, e: 4000, v: [60, 12] });
  // いちばん長く話した speaker1 が話者 0
  assert.deepEqual(r.speakers, [
    { index: 0, ms: 6000 },
    { index: 1, ms: 1000 },
  ]);
  // 句読点は信頼度が低くても数えない
  assert.deepEqual(
    r.lowConfidence.map((l) => l.written),
    ["ハナシ"],
  );
  assert.equal(r.lowConfidence[0]?.context, "今日は話します。");
  // アーカイブ「今日は話します質問です」（11 文字）に対し、ライブは「です」→「でした」で 1 文字置換・1 文字挿入
  assert.ok(r.liveVsArchive);
  assert.equal(r.liveVsArchive.cer, 2 / 11);
});

test("感情分析が失敗したときは理由を残す", () => {
  const r = buildReport({ segments: [], sentiment_analysis: { code: 400, error_code: "BAD_REQUEST", error_message: "file format is invalid" } }, null, "");
  assert.equal(r.sentiment, null);
  assert.equal(r.sentimentError, "file format is invalid");
  assert.equal(r.liveVsArchive, null);
});

/** R2 のマルチパートアップロードの代わり。送られたパートを覚えておく。 */
function fakeBucket() {
  const uploaded: { n: number; bytes: number }[] = [];
  let completed: UploadedPart[] | null = null;
  let aborted = false;
  const bucket: BucketLike = {
    async createMultipartUpload() {
      return {
        uploadId: "u1",
        async uploadPart(n: number, value: Uint8Array) {
          uploaded.push({ n, bytes: value.byteLength });
          return { partNumber: n, etag: `e${n}` };
        },
        async complete(parts: UploadedPart[]) {
          completed = parts;
        },
        async abort() {
          aborted = true;
        },
      };
    },
  };
  return { bucket, uploaded, completed: () => completed, aborted: () => aborted };
}

test("録音は最後以外のパートを同じ大きさ（PART_SIZE）に切って送り、完了させる", async () => {
  const f = fakeBucket();
  const progress: number[] = [];
  const rec = new Recording(f.bucket, "k", (_id, parts) => progress.push(parts.length));
  const chunk = new Uint8Array(3200); // 100ms
  const chunks = Math.ceil((PART_SIZE * 2 + 1000) / chunk.byteLength);
  for (let i = 0; i < chunks; i++) rec.append(chunk);
  const out = await rec.finish();
  const total = chunks * chunk.byteLength;
  assert.deepEqual(out, { bytes: total });
  assert.deepEqual(
    f.uploaded.map((u) => u.bytes),
    [PART_SIZE, PART_SIZE, total - PART_SIZE * 2],
  );
  assert.deepEqual(
    f.uploaded.map((u) => u.n),
    [1, 2, 3],
  );
  assert.equal(f.completed()?.length, 3);
  assert.deepEqual(progress, [0, 1, 2, 3]);
});

test("音声が 1 バイトも無ければ録音を破棄する", async () => {
  const f = fakeBucket();
  const rec = new Recording(f.bucket, "k", () => {});
  assert.equal(await rec.finish(), null);
  assert.equal(f.aborted(), true);
  assert.equal(f.completed(), null);
});

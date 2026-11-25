import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAudioPacket,
  buildProfileWords,
  buildStartCommand,
  decodeWritten,
  engineKind,
  isValidReading,
  normalizeReading,
  parseServerEvent,
  parseStartParam,
  resultEndTime,
  type DictionaryTerm,
} from "../src/shared/amivoice.ts";

const terms: DictionaryTerm[] = [
  { written: "Durable Objects", readings: ["でゅらぶるおぶじぇくつ"] },
  { written: "SQL", readings: ["えすきゅーえる", "しーくぇる"] },
  { written: "壊れた読み", readings: ["abc"] },
];

test("ハイブリッドエンジンの profileWords は「表記 読み」を | で区切り、スペースは _ に置き換える", () => {
  assert.equal(
    buildProfileWords(terms, "hybrid"),
    "Durable_Objects でゅらぶるおぶじぇくつ|SQL えすきゅーえる|SQL しーくぇる",
  );
});

test("E2E エンジンの profileWords（単語強調）は表記だけを並べる", () => {
  assert.equal(buildProfileWords(terms, "e2e"), "Durable_Objects|SQL|壊れた読み");
});

test("区切り文字を含む表記は登録しない", () => {
  assert.equal(buildProfileWords([{ written: "a|b", readings: ["えー"] }], "hybrid"), "");
});

test("カタカナ・半角カナの読みはひらがなに直して登録する", () => {
  assert.equal(normalizeReading("ラングラー"), "らんぐらー");
  assert.equal(normalizeReading("ﾗﾝｸﾞﾗｰ"), "らんぐらー");
  assert.equal(normalizeReading("ヴィート"), "ゔぃーと");
  assert.equal(buildProfileWords([{ written: "Wrangler", readings: ["ラングラー"] }], "hybrid"), "Wrangler らんぐらー");
});

test("読みはひらがなと長音記号だけを受け付ける", () => {
  assert.ok(isValidReading("えーだぶりゅーえす"));
  assert.ok(!isValidReading("エーダブリューエス"));
  assert.ok(!isValidReading("aws"));
  assert.ok(!isValidReading(""));
});

test("s コマンドは空白を含む値を引用符で囲み、内部の引用符を二重にする", () => {
  const cmd = buildStartCommand({
    engine: "-a-general",
    authorization: "KEY",
    profileWords: 'A あ|B "い"',
    resultUpdatedInterval: 200,
    segmenter: { postTime: 400, preTime: 200 },
  });
  assert.equal(
    cmd,
    's LSB16K -a-general authorization=KEY profileWords="A あ|B ""い""" resultUpdatedInterval=200 segmenterProperties="postTime=400 preTime=200"',
  );
  // モックサーバ側の解釈と往復できる
  assert.equal(parseStartParam(cmd, "profileWords"), 'A あ|B "い"');
  assert.equal(parseStartParam(cmd, "authorization"), "KEY");
});

test("認識結果の _ を元のスペースに戻す", () => {
  assert.equal(decodeWritten("今日は Durable_Objects の話", terms), "今日は Durable Objects の話");
});

test("サーバイベントを解釈する", () => {
  assert.deepEqual(parseServerEvent("s"), { kind: "s" });
  assert.deepEqual(parseServerEvent("s received unsupported audio format"), { kind: "s", error: "received unsupported audio format" });
  assert.deepEqual(parseServerEvent("S 1200"), { kind: "S", time: 1200 });
  assert.deepEqual(parseServerEvent("E 3400"), { kind: "E", time: 3400 });
  assert.deepEqual(parseServerEvent("e"), { kind: "e" });
  const a = parseServerEvent('A {"text":"\\u3053\\u3093\\u306b\\u3061\\u306f","results":[{"endtime":900,"tokens":[{"written":"x","endtime":950}]}]}');
  assert.equal(a.kind, "A");
  if (a.kind === "A") {
    assert.equal(a.result.text, "こんにちは");
    assert.equal(resultEndTime(a.result), 950);
  }
  assert.equal(parseServerEvent("U {broken").kind, "unknown");
});

test("音声パケットの先頭は p", () => {
  const packet = buildAudioPacket(new Uint8Array([1, 2]));
  assert.deepEqual([...packet], [0x70, 1, 2]);
});

test("エンジンの種類を判定する", () => {
  assert.equal(engineKind("-a2-ja-general"), "e2e");
  assert.equal(engineKind("-a-general"), "hybrid");
});

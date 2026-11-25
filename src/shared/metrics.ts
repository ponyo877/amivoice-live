// 文字誤り率（CER）などの指標。評価スクリプトと、レポートの「ライブ字幕とアーカイブの食い違い」で使う。

/**
 * 比較のための正規化。表記ゆれで誤り扱いにならないよう、
 * NFKC（全角英数→半角など）、英字の小文字化、空白・句読点・記号の除去を行う。
 * カタカナと英字の違い（「デュラブル」と「Durable」）は誤りとして数える。それが辞書で直したい誤りだから。
 */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

/** 文字単位のレーベンシュタイン距離。 */
export function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length]!;
}

/** 文字誤り率 = 編集距離 / 正解の文字数（正規化後）。 */
export function cer(reference: string, hypothesis: string): { cer: number; errors: number; length: number } {
  const ref = normalize(reference);
  const hyp = normalize(hypothesis);
  const errors = editDistance(ref, hyp);
  const length = [...ref].length;
  return { cer: length === 0 ? 0 : errors / length, errors, length };
}

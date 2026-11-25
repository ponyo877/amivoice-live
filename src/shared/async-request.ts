// 非同期 HTTP API に送るリクエストの組み立て（実行環境に依存しない部分）。
// https://docs.amivoice.com/amivoice-api/manual/async-http-interface

const SAMPLE_RATE = 16000;

/**
 * d パラメータを組み立てる。key=value を半角スペースで区切り、値は URL エンコードする
 * （profileWords のようにスペースや | を含む値があるため。公式サンプルも値をエンコードしている）。
 */
export function buildDParam(params: Record<string, string | undefined>): string {
  return Object.entries(params)
    .filter((e): e is [string, string] => e[1] !== undefined && e[1] !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join(" ");
}

/** 16kHz・16bit・モノラル PCM の WAV ヘッダ（44 バイト）。 */
export function wavHeader(pcmBytes: number): Uint8Array {
  const buf = new ArrayBuffer(44);
  const v = new DataView(buf);
  const ascii = (offset: number, s: string) => [...s].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + pcmBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt チャンクの長さ
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // モノラル
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true); // バイト/秒
  v.setUint16(32, 2, true); // ブロックサイズ
  v.setUint16(34, 16, true); // ビット深度
  ascii(36, "data");
  v.setUint32(40, pcmBytes, true);
  return new Uint8Array(buf);
}

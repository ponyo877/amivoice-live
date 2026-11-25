// AmiVoice 非同期 HTTP API（v2）のクライアント。登壇の録音（R2 の PCM）を送り、結果を取りに行く。
// https://docs.amivoice.com/amivoice-api/manual/async-http-interface

import { wavHeader } from "../shared/async-request.ts";
import type { AsyncJobResult } from "../shared/async-result.ts";

/**
 * 録音（R2 に置いたヘッダなし PCM）を WAV にしてジョブを作り、sessionid を返す。
 * 30 分の登壇で 60MB 近くになるので、メモリに載せずにストリームで送る。
 * Content-Length を付けるため、全体の長さを先に計算して FixedLengthStream に流し込む。
 */
export async function submitRecording(env: Env, recording: R2ObjectBody, d: string): Promise<string> {
  const boundary = `----amivoicelive${crypto.randomUUID().replace(/-/g, "")}`;
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="d"\r\n\r\n${d}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="a"; filename="talk.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
  );
  const header = wavHeader(recording.size);
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const total = head.byteLength + header.byteLength + recording.size + tail.byteLength;

  const { readable, writable } = new FixedLengthStream(total);
  const pump = (async () => {
    const w1 = writable.getWriter();
    await w1.write(head);
    await w1.write(header);
    w1.releaseLock();
    await recording.body.pipeTo(writable, { preventClose: true });
    const w2 = writable.getWriter();
    await w2.write(tail);
    await w2.close();
  })();

  const [res] = await Promise.all([
    fetch(env.AMIVOICE_ASYNC_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.AMIVOICE_API_KEY}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body: readable,
    }),
    pump,
  ]);
  const body = (await res.json().catch(() => ({}))) as { sessionid?: string; code?: string; message?: string };
  if (!res.ok || !body.sessionid) {
    throw new Error(`ジョブを作れませんでした（HTTP ${res.status}${body.code ? ` code=${body.code}` : ""}${body.message ? ` ${body.message}` : ""}）`);
  }
  return body.sessionid;
}

/** ジョブの状態を取る。completed なら結果の全体が入っている。 */
export async function getJob(env: Env, sessionId: string): Promise<{ job: AsyncJobResult; raw: string }> {
  const res = await fetch(`${env.AMIVOICE_ASYNC_URL}/${encodeURIComponent(sessionId)}`, {
    headers: { authorization: `Bearer ${env.AMIVOICE_API_KEY}` },
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`ジョブの状態を取れませんでした（HTTP ${res.status}）`);
  return { job: JSON.parse(raw) as AsyncJobResult, raw };
}

/**
 * 感情分析の 20 個のパラメータの名前一覧。マニュアルには日本語名しか無く、結果 JSON のキー名との対応はこの API から取る。
 * https://docs.amivoice.com/amivoice-api/manual/sentiment-analysis
 */
export async function getSentimentParameters(env: Env): Promise<unknown> {
  const res = await fetch(env.AMIVOICE_SENTIMENT_PARAMS_URL, {
    headers: { authorization: `Bearer ${env.AMIVOICE_API_KEY}` },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

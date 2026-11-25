// 登壇の音声（AmiVoice に送ったのと同じ 16kHz PCM）を R2 に書き込む。
// 終了後に非同期 HTTP API で認識し直すためのもので、ライブ字幕とアーカイブを同じ音声で比べられる。
//
// R2 のマルチパートアップロードは、最後以外のパートを同じ大きさ（5MiB 以上）にする必要があるので、
// ちょうど PART_SIZE ずつ切り出して送る。送ったパートは onProgress で SQLite に記録し、
// DO が配信中に再起動しても、そこまでの録音を resumeMultipartUpload で回収できるようにする。

export const PART_SIZE = 5 * 1024 * 1024;

// R2Bucket のうち、ここで使う部分だけ（テストで差し替えられるように）
export interface UploadedPart {
  partNumber: number;
  etag: string;
}
export interface MultipartUploadLike {
  readonly uploadId: string;
  uploadPart(partNumber: number, value: Uint8Array): Promise<UploadedPart>;
  complete(parts: UploadedPart[]): Promise<unknown>;
  abort(): Promise<void>;
}
export interface BucketLike {
  createMultipartUpload(key: string, options?: { httpMetadata?: { contentType?: string } }): Promise<MultipartUploadLike>;
}

export class Recording {
  readonly key: string;
  private readonly uploadP: Promise<MultipartUploadLike>;
  private readonly onProgress: (uploadId: string, parts: UploadedPart[]) => void;
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private partNumber = 0;
  private chain: Promise<void>;
  private failed: string | null = null;
  readonly parts: UploadedPart[] = [];
  totalBytes = 0;

  constructor(bucket: BucketLike, key: string, onProgress: (uploadId: string, parts: UploadedPart[]) => void) {
    this.key = key;
    this.onProgress = onProgress;
    this.uploadP = bucket.createMultipartUpload(key, { httpMetadata: { contentType: "audio/L16;rate=16000;channels=1" } });
    this.chain = this.uploadP.then(
      (u) => this.onProgress(u.uploadId, this.parts),
      (err) => {
        this.failed = `録音を始められませんでした: ${errorMessage(err)}`;
      },
    );
  }

  append(chunk: Uint8Array): void {
    if (this.failed) return;
    this.chunks.push(chunk);
    this.buffered += chunk.byteLength;
    this.totalBytes += chunk.byteLength;
    while (this.buffered >= PART_SIZE) this.enqueue(this.take(PART_SIZE));
  }

  /** 残りを送り切って完了させる。音声が無ければ破棄して null を返す。 */
  async finish(): Promise<{ bytes: number } | null> {
    if (this.buffered > 0) this.enqueue(this.take(this.buffered));
    await this.chain;
    if (this.failed) {
      await this.uploadP.then((u) => u.abort()).catch(() => {});
      throw new Error(this.failed);
    }
    const upload = await this.uploadP;
    if (this.parts.length === 0) {
      await upload.abort();
      return null;
    }
    await upload.complete(this.parts);
    return { bytes: this.totalBytes };
  }

  private enqueue(part: Uint8Array): void {
    const n = ++this.partNumber;
    this.chain = this.chain.then(async () => {
      if (this.failed) return;
      try {
        const upload = await this.uploadP;
        this.parts.push(await upload.uploadPart(n, part));
        this.onProgress(upload.uploadId, this.parts);
      } catch (err) {
        this.failed = `録音の書き込みに失敗しました: ${errorMessage(err)}`;
      }
    });
  }

  /** 溜めたチャンクの先頭から n バイトを取り出す。 */
  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0]!;
      const need = n - filled;
      if (head.byteLength <= need) {
        out.set(head, filled);
        filled += head.byteLength;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        this.chunks[0] = head.subarray(need);
        filled += need;
      }
    }
    this.buffered -= n;
    return out;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

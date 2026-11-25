// マイクなどの音声を 16kHz・16bit・モノラルの PCM に変換し、100ms ごとにメインスレッドへ送る AudioWorklet。
// AudioContext を 16kHz で作れた環境では変換なし、作れなかった環境（48kHz など）では間引いて 16kHz にする。

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100ms

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.buffer = new Int16Array(CHUNK_SAMPLES);
    this.filled = 0;
    this.pos = 0; // 入力サンプル上の次の取り出し位置（小数）
    this.acc = 0; // 間引くときの区間平均用
    this.accCount = 0;
    this.sumSquares = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const input = channels[0];
    for (let i = 0; i < input.length; i++) {
      // 複数チャネルなら平均してモノラルにする
      let s = 0;
      for (let c = 0; c < channels.length; c++) s += channels[c][i];
      s /= channels.length;

      if (this.ratio === 1) {
        this.push(s);
        continue;
      }
      // 区間平均で簡易的に高域を落としてから間引く
      this.acc += s;
      this.accCount++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        this.push(this.acc / this.accCount);
        this.acc = 0;
        this.accCount = 0;
      }
    }
    return true;
  }

  push(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.buffer[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    this.sumSquares += clamped * clamped;
    if (this.filled === CHUNK_SAMPLES) {
      const level = Math.sqrt(this.sumSquares / CHUNK_SAMPLES);
      const out = this.buffer.buffer;
      this.port.postMessage({ pcm: out, level }, [out]);
      this.buffer = new Int16Array(CHUNK_SAMPLES);
      this.filled = 0;
      this.sumSquares = 0;
    }
  }
}

registerProcessor("pcm-processor", PcmProcessor);

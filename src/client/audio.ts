// 音声の取り込み。マイク・ブラウザのタブの音声・音声ファイルのいずれかを 16kHz PCM にして渡す。

export type AudioSourceKind = "mic" | "tab" | "file";

export interface CaptureOptions {
  kind: AudioSourceKind;
  deviceId?: string;
  file?: File;
  /** 100ms ごとの PCM（16kHz・16bit・モノラル・リトルエンディアン） */
  onChunk: (pcm: ArrayBuffer) => void;
  /** 0〜1 の音量（RMS） */
  onLevel?: (level: number) => void;
  /** 音声ファイルを最後まで流し終えたとき */
  onEnded?: () => void;
}

export interface Capture {
  stop: () => void;
}

const WORKLET_URL = "/pcm-worklet.js";

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput");
}

export async function startCapture(opts: CaptureOptions): Promise<Capture> {
  let stream: MediaStream | null = null;
  let mediaEl: HTMLAudioElement | null = null;
  if (opts.kind === "file") {
    if (!opts.file) throw new Error("音声ファイルを選んでください");
    mediaEl = new Audio(URL.createObjectURL(opts.file));
    mediaEl.addEventListener("ended", () => opts.onEnded?.());
  } else {
    stream = opts.kind === "tab" ? await captureTabAudio() : await captureMic(opts.deviceId);
  }

  // 16kHz の AudioContext を作れればブラウザ側で高品質に変換される。
  // Firefox などレートの違うマイクをつなげない環境では、既定のレートで作り直して Worklet で間引く
  let ctx = new AudioContext({ sampleRate: 16000 });
  let source: AudioNode;
  try {
    source = connectSource(ctx, stream, mediaEl);
  } catch {
    await ctx.close();
    ctx = new AudioContext();
    source = connectSource(ctx, stream, mediaEl);
  }

  await ctx.audioWorklet.addModule(WORKLET_URL);
  const worklet = new AudioWorkletNode(ctx, "pcm-processor", { channelCount: 1, channelCountMode: "explicit" });
  worklet.port.onmessage = (ev: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
    opts.onChunk(ev.data.pcm);
    opts.onLevel?.(ev.data.level);
  };

  // AudioWorklet は出力先につながっていないと動かないブラウザがあるので、無音のゲイン経由で destination につなぐ
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(worklet).connect(mute).connect(ctx.destination);
  if (mediaEl) await mediaEl.play();

  return {
    stop: () => {
      stream?.getTracks().forEach((t) => t.stop());
      mediaEl?.pause();
      worklet.port.onmessage = null;
      void ctx.close();
    },
  };
}

function connectSource(ctx: AudioContext, stream: MediaStream | null, mediaEl: HTMLAudioElement | null): AudioNode {
  if (stream) return ctx.createMediaStreamSource(stream);
  const el = ctx.createMediaElementSource(mediaEl!);
  el.connect(ctx.destination); // 流している音を登壇者にも聞かせる
  return el;
}

async function captureMic(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}

async function captureTabAudio(): Promise<MediaStream> {
  // 画面共有のダイアログで「タブの音声を共有」を選んでもらう。映像は使わないのですぐ止める
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  stream.getVideoTracks().forEach((t) => t.stop());
  if (stream.getAudioTracks().length === 0) {
    throw new Error("音声が共有されませんでした。共有ダイアログで「タブの音声も共有する」を有効にしてください");
  }
  return new MediaStream(stream.getAudioTracks());
}

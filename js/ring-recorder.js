// リングバッファ録画(MediaRecorder 二重セグメント方式)
//
// iOS Safari では MediaRecorder の timeslice 分割チャンクは単体で再生できず
// (先頭チャンクの初期化セグメントに依存)、古いチャンクを捨てる方式が使えない。
// フレームバッファ方式(ImageBitmap 蓄積)は 720p×5秒で数百MBになりメモリ制約を
// 超える。そこで本実装は「一定間隔で新しい MediaRecorder を起動し、常に最大2本を
// 並走させる」方式を採る。各レコーダーは開始から停止までの完全な動画ファイルを
// 生成するため単体で再生可能で、最も古いレコーダーは常に segmentSec 秒以上の
// 過去映像を保持している。インパクト検知時は postSec 秒だけ録り足してから停止し、
// 得られた blob と「blob 内でのインパクト時刻オフセット」を返す。実際の再生区間
// (前X秒〜後Y秒)は再生側がメタデータで制御する。

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', // iOS Safari
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch { /* ignore */ }
  }
  return ''; // ブラウザ既定に任せる
}

export class RingRecorder {
  /**
   * @param {MediaStream} stream カメラ+マイクのストリーム
   * @param {number} segmentSec セグメント切替間隔(preSec より長くすること)
   */
  constructor(stream, segmentSec) {
    this.stream = stream;
    this.segmentSec = Math.max(4, segmentSec);
    this.mimeType = pickMimeType();
    this.segments = [];   // { rec, startTime, chunks } 新しいものが末尾
    this.timer = null;
    this.capturing = false;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._startSegment();
    this.timer = setInterval(() => this._rotate(), this.segmentSec * 1000);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const seg of this.segments) {
      try { seg.rec.stop(); } catch { /* already stopped */ }
    }
    this.segments = [];
  }

  _startSegment() {
    const options = { videoBitsPerSecond: 5_000_000 };
    if (this.mimeType) options.mimeType = this.mimeType;
    let rec;
    try {
      rec = new MediaRecorder(this.stream, options);
    } catch {
      rec = new MediaRecorder(this.stream); // オプション非対応端末向けフォールバック
    }
    const seg = { rec, startTime: performance.now(), chunks: [] };
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) seg.chunks.push(e.data);
    };
    rec.start(); // timeslice なし: stop 時に単体再生可能な完全ファイルを得る
    this.segments.push(seg);
  }

  _rotate() {
    if (!this.running || this.capturing) return;
    this._startSegment();
    // 3本以上になったら最古を破棄(常に最大2本 = メモリ上は最大 2×2セグメント秒分)
    while (this.segments.length > 2) {
      const old = this.segments.shift();
      old.rec.ondataavailable = null;
      try { old.rec.stop(); } catch { /* ignore */ }
    }
  }

  /**
   * インパクト検知時の切り出し。postSec 秒待って最古セグメントを停止し blob 化する。
   * @returns {Promise<{blob: Blob, impactOffsetSec: number}|null>}
   */
  async capture(postSec) {
    if (!this.running || this.capturing || this.segments.length === 0) return null;
    this.capturing = true;
    const impactTime = performance.now();
    const target = this.segments[0]; // 最も長く回っている=最も多くの過去を持つ

    try {
      await new Promise((r) => setTimeout(r, postSec * 1000));

      const blob = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('recorder stop timeout')), 8000);
        target.rec.onstop = () => {
          clearTimeout(timeout);
          const type = target.rec.mimeType || this.mimeType || 'video/mp4';
          resolve(new Blob(target.chunks, { type }));
        };
        try {
          target.rec.stop();
        } catch (e) {
          clearTimeout(timeout);
          reject(e);
        }
      });

      const impactOffsetSec = (impactTime - target.startTime) / 1000;

      // 残りのセグメントを破棄してバッファを仕切り直す
      for (const seg of this.segments) {
        if (seg === target) continue;
        seg.rec.ondataavailable = null;
        try { seg.rec.stop(); } catch { /* ignore */ }
      }
      this.segments = [];
      if (this.running) this._startSegment();

      return { blob, impactOffsetSec };
    } finally {
      this.capturing = false;
    }
  }
}

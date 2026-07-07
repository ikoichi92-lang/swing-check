// 打球音検知(Web Audio API)
//
// マイク入力を高域フィルタ(3kHz以上)に通した時間波形ピーク振幅(0〜1)を監視する。
// 打球音は高周波成分が強く、隣の打席の打球音や環境音は距離減衰で高域が落ちるため、
// 高域だけを見ることで誤検知を減らす。さらに「直前の環境音レベルに対して十分大きい
// 瞬間的なスパイクか」を判定し、ざわつき等の持続音では反応しないようにする。
// iOS Safari では AudioContext はユーザー操作後に生成・resume する必要があるため、
// セッション開始ボタンから start() を呼ぶ。

const HIGHPASS_HZ = 3000;   // これ未満の帯域は無視(声・風・遠くの音対策)
const SPIKE_RATIO = 2.5;    // 直前環境音の何倍でスパイクとみなすか
const BASE_WINDOW_MS = 500; // 環境音レベルの計測窓
const BASE_EXCLUDE_MS = 80; // スパイク自身を環境音に含めないための除外時間

export class AudioDetector {
  /**
   * @param {MediaStream} stream マイクを含むストリーム
   * @param {object} handlers
   * @param {() => number} handlers.getThreshold しきい値(0〜1)
   * @param {() => number} handlers.getCooldownSec クールダウン秒数
   * @param {(level: number) => void} handlers.onLevel レベル更新(毎フレーム)
   * @param {() => void} handlers.onImpact インパクト検知
   */
  constructor(stream, { getThreshold, getCooldownSec, onLevel, onImpact }) {
    this.stream = stream;
    this.getThreshold = getThreshold;
    this.getCooldownSec = getCooldownSec;
    this.onLevel = onLevel;
    this.onImpact = onImpact;
    this.ctx = null;
    this.analyser = null;
    this.rafId = null;
    this.lastImpactAt = 0;
    this.running = false;
    this.history = []; // {t, peak} 直近の環境音レベル
  }

  async start() {
    if (this.running) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioCtx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const source = this.ctx.createMediaStreamSource(this.stream);
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = HIGHPASS_HZ;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    source.connect(filter);
    filter.connect(this.analyser);
    // 出力(destination)へは接続しない=ハウリングしない

    this.buf = new Uint8Array(this.analyser.fftSize);
    this.running = true;
    this._loop();
  }

  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* ignore */ }
    }
  }

  _loop() {
    if (!this.running) return;
    this.analyser.getByteTimeDomainData(this.buf);
    let peak = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const v = Math.abs(this.buf[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    this.onLevel(peak);

    const now = performance.now();

    // 環境音レベル(直近500ms、ただし直近80msはスパイク自身の可能性があるので除外)
    this.history.push({ t: now, peak });
    while (this.history.length && now - this.history[0].t > BASE_WINDOW_MS) {
      this.history.shift();
    }
    let sum = 0;
    let n = 0;
    for (const h of this.history) {
      if (now - h.t > BASE_EXCLUDE_MS) { sum += h.peak; n++; }
    }
    const base = n ? sum / n : 0;

    const overThreshold = peak >= this.getThreshold();
    const isSpike = base < 0.02 || peak >= base * SPIKE_RATIO;
    if (
      overThreshold && isSpike &&
      now - this.lastImpactAt > this.getCooldownSec() * 1000
    ) {
      this.lastImpactAt = now;
      this.onImpact();
    }
    this.rafId = requestAnimationFrame(() => this._loop());
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.ctx) {
      try { this.ctx.close(); } catch { /* ignore */ }
    }
    this.ctx = null;
    this.analyser = null;
    this.history = [];
  }
}

// 打球音検知(Web Audio API)
//
// マイク入力の時間波形ピーク振幅(0〜1)を監視し、しきい値を超えたら
// インパクトとみなす。iOS Safari では AudioContext はユーザー操作後に
// 生成・resume する必要があるため、セッション開始ボタンから start() を呼ぶ。

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
  }

  async start() {
    if (this.running) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioCtx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    source.connect(this.analyser);
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
    if (
      peak >= this.getThreshold() &&
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
  }
}

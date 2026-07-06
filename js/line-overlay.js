// ライン描画オーバーレイ
//
// 線は「動画コンテンツ領域(object-fit: contain の実表示矩形)」に対する
// 正規化座標(0〜1)で保持する。カメラ固定前提なので、同じ正規化座標を
// ライブプレビューと全クリップの両方に適用すれば同じ位置に線が出る。
// 斜め線は端点2つを通る直線として画面端まで延長して描画する
// (シャフトプレーン用途では延長線の方が使いやすいため)。
//
// モード: 'move'(既存の線をドラッグで移動・端点調整) / 'free' / 'v' / 'h'(追加)
// 線を1本追加したら onLineAdded を呼び、呼び出し側が move モードへ戻す
// (追加モードのまま触るたびに線が増える誤操作を防ぐ)。

const LINES_KEY = 'swing-check:lines';

export const LINE_COLORS = ['#38c17f', '#e5c04b', '#e05a5a', '#ffffff'];

const GRAB_ENDPOINT_PX = 26; // 端点をつかめる距離
const GRAB_LINE_PX = 20;     // 線本体をつかめる距離

function loadLines() {
  try {
    const raw = localStorage.getItem(LINES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// 全 LineOverlay インスタンスで共有する線データ
export const lineStore = {
  // {type:'free'|'v'|'h', x1,y1,x2,y2, color} 座標は正規化(0〜1)
  lines: loadLines(),
  listeners: new Set(),

  save() {
    try { localStorage.setItem(LINES_KEY, JSON.stringify(this.lines)); } catch { /* ignore */ }
  },
  add(line) {
    this.lines.push(line);
    this.save();
    this.emit();
  },
  undo() {
    if (!this.lines.length) return false;
    this.lines.pop();
    this.save();
    this.emit();
    return true;
  },
  clear() {
    this.lines = [];
    this.save();
    this.emit();
  },
  emit() {
    this.listeners.forEach((fn) => fn());
  },
};

export class LineOverlay {
  /**
   * @param {HTMLElement} wrap 動画を包む要素(position: relative/absolute 前提)
   * @param {HTMLVideoElement} video 対象の video 要素
   * @param {{onLineAdded?: () => void}} [opts]
   */
  constructor(wrap, video, opts = {}) {
    this.wrap = wrap;
    this.video = video;
    this.onLineAdded = opts.onLineAdded || null;
    this.drawType = null;   // null | 'move' | 'free' | 'v' | 'h'
    this.color = LINE_COLORS[0];
    this.dragStart = null;   // free 線作成ドラッグの始点(正規化)
    this.dragCurrent = null;
    this.pending = null;     // v/h 作成中の仮線
    this.grab = null;        // move 中 {index, part:'p1'|'p2'|'body', start, orig}

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'line-canvas';
    wrap.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this._redraw = () => this.redraw();
    lineStore.listeners.add(this._redraw);
    window.addEventListener('resize', this._redraw);
    window.addEventListener('orientationchange', this._redraw);
    video.addEventListener('loadedmetadata', this._redraw);
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(this._redraw);
      this.ro.observe(wrap);
    }

    this.canvas.addEventListener('pointerdown', (e) => this._onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this._onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this._onUp(e));
    this.canvas.addEventListener('pointercancel', () => {
      this.dragStart = null; this.pending = null; this.grab = null;
      this.redraw();
    });

    this.redraw();
  }

  /** モード設定。null で閲覧のみ(タッチ透過) */
  setDrawType(type) {
    this.drawType = type;
    this.canvas.classList.toggle('drawing', !!type);
    this.dragStart = null;
    this.pending = null;
    this.grab = null;
    this.redraw(); // 端点ハンドルの表示/非表示を反映
  }

  setColor(color) { this.color = color; }

  /** 動画コンテンツの実表示矩形(letterbox を除いた領域) */
  _contentRect() {
    const W = this.wrap.clientWidth;
    const H = this.wrap.clientHeight;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return { x: 0, y: 0, w: W, h: H };
    const scale = Math.min(W / vw, H / vh);
    const w = vw * scale;
    const h = vh * scale;
    return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }

  _toNorm(e) {
    const bounds = this.canvas.getBoundingClientRect();
    const r = this._contentRect();
    return {
      x: (e.clientX - bounds.left - r.x) / r.w,
      y: (e.clientY - bounds.top - r.y) / r.h,
    };
  }

  _toPx(p) {
    const r = this._contentRect();
    return { x: r.x + p.x * r.w, y: r.y + p.y * r.h };
  }

  /** move モードのヒットテスト。端点優先、次に線本体 */
  _hitTest(pNorm) {
    const p = this._toPx(pNorm);
    // 端点(斜め線のみ)
    for (let i = lineStore.lines.length - 1; i >= 0; i--) {
      const l = lineStore.lines[i];
      if (l.type !== 'free') continue;
      const p1 = this._toPx({ x: l.x1, y: l.y1 });
      const p2 = this._toPx({ x: l.x2, y: l.y2 });
      if (Math.hypot(p.x - p1.x, p.y - p1.y) < GRAB_ENDPOINT_PX) return { index: i, part: 'p1' };
      if (Math.hypot(p.x - p2.x, p.y - p2.y) < GRAB_ENDPOINT_PX) return { index: i, part: 'p2' };
    }
    // 線本体
    for (let i = lineStore.lines.length - 1; i >= 0; i--) {
      const l = lineStore.lines[i];
      if (l.type === 'v') {
        if (Math.abs(p.x - this._toPx({ x: l.x1, y: 0 }).x) < GRAB_LINE_PX) return { index: i, part: 'body' };
      } else if (l.type === 'h') {
        if (Math.abs(p.y - this._toPx({ x: 0, y: l.y1 }).y) < GRAB_LINE_PX) return { index: i, part: 'body' };
      } else {
        const p1 = this._toPx({ x: l.x1, y: l.y1 });
        const p2 = this._toPx({ x: l.x2, y: l.y2 });
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        const len = Math.hypot(dx, dy) || 1;
        // 無限直線との距離(表示も延長線なので)
        const dist = Math.abs(dy * (p.x - p1.x) - dx * (p.y - p1.y)) / len;
        if (dist < GRAB_LINE_PX) return { index: i, part: 'body' };
      }
    }
    return null;
  }

  _onDown(e) {
    if (!this.drawType) return;
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const p = this._toNorm(e);

    if (this.drawType === 'move') {
      const hit = this._hitTest(p);
      if (hit) {
        this.grab = { ...hit, start: p, orig: { ...lineStore.lines[hit.index] } };
      }
    } else if (this.drawType === 'v') {
      this.pending = { type: 'v', x1: p.x, y1: 0, x2: p.x, y2: 1, color: this.color };
      this.redraw();
    } else if (this.drawType === 'h') {
      this.pending = { type: 'h', x1: 0, y1: p.y, x2: 1, y2: p.y, color: this.color };
      this.redraw();
    } else {
      this.dragStart = p;
      this.dragCurrent = p;
    }
  }

  _onMove(e) {
    const p = this._toNorm(e);
    if (this.grab) {
      e.preventDefault();
      const g = this.grab;
      const line = lineStore.lines[g.index];
      const dx = p.x - g.start.x;
      const dy = p.y - g.start.y;
      if (g.part === 'p1') {
        line.x1 = g.orig.x1 + dx; line.y1 = g.orig.y1 + dy;
      } else if (g.part === 'p2') {
        line.x2 = g.orig.x2 + dx; line.y2 = g.orig.y2 + dy;
      } else if (line.type === 'v') {
        line.x1 = line.x2 = g.orig.x1 + dx;
      } else if (line.type === 'h') {
        line.y1 = line.y2 = g.orig.y1 + dy;
      } else {
        line.x1 = g.orig.x1 + dx; line.y1 = g.orig.y1 + dy;
        line.x2 = g.orig.x2 + dx; line.y2 = g.orig.y2 + dy;
      }
      lineStore.emit(); // ライブ側にも即反映
    } else if (this.pending) {
      e.preventDefault();
      if (this.pending.type === 'v') this.pending.x1 = this.pending.x2 = p.x;
      else this.pending.y1 = this.pending.y2 = p.y;
      this.redraw();
    } else if (this.dragStart) {
      e.preventDefault();
      this.dragCurrent = p;
      this.redraw();
    }
  }

  _onUp(e) {
    if (this.grab) {
      this.grab = null;
      lineStore.save();
      return;
    }
    if (this.pending) {
      const line = this.pending;
      this.pending = null;
      lineStore.add(line);
      if (this.onLineAdded) this.onLineAdded();
      return;
    }
    if (this.dragStart) {
      const end = this._toNorm(e);
      const s = this.dragStart;
      this.dragStart = null;
      // ほぼ動かないタップは誤操作として無視
      if (Math.hypot(end.x - s.x, end.y - s.y) > 0.02) {
        lineStore.add({ type: 'free', x1: s.x, y1: s.y, x2: end.x, y2: end.y, color: this.color });
        if (this.onLineAdded) this.onLineAdded();
      } else {
        this.redraw();
      }
    }
  }

  redraw() {
    const W = this.wrap.clientWidth;
    const H = this.wrap.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== W * dpr || this.canvas.height !== H * dpr) {
      this.canvas.width = W * dpr;
      this.canvas.height = H * dpr;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const r = this._contentRect();
    const toPx = (p) => ({ x: r.x + p.x * r.w, y: r.y + p.y * r.h });

    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';

    for (const line of lineStore.lines) {
      this._strokeLine(ctx, line, toPx);
    }
    if (this.pending) this._strokeLine(ctx, this.pending, toPx);
    if (this.dragStart && this.dragCurrent) {
      this._strokeLine(ctx, {
        type: 'free',
        x1: this.dragStart.x, y1: this.dragStart.y,
        x2: this.dragCurrent.x, y2: this.dragCurrent.y,
        color: this.color,
      }, toPx);
    }

    // 編集中は操作ハンドルを表示(斜め線=端点○、縦横線=中央○)
    if (this.drawType) {
      for (const line of lineStore.lines) {
        if (line.type === 'free') {
          this._drawHandle(ctx, toPx({ x: line.x1, y: line.y1 }), line.color);
          this._drawHandle(ctx, toPx({ x: line.x2, y: line.y2 }), line.color);
        } else {
          this._drawHandle(ctx, toPx({
            x: line.type === 'v' ? line.x1 : 0.5,
            y: line.type === 'h' ? line.y1 : 0.5,
          }), line.color);
        }
      }
    }
    ctx.restore();
  }

  _drawHandle(ctx, p, color) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.lineWidth = 3;
  }

  _strokeLine(ctx, line, toPx) {
    let p1 = toPx({ x: line.x1, y: line.y1 });
    let p2 = toPx({ x: line.x2, y: line.y2 });
    if (line.type === 'free') {
      // 2点を通る直線として大きく延長(clip 済みなので画面端で切れる)
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy) || 1;
      const ext = 10000 / len;
      p1 = { x: p1.x - dx * ext, y: p1.y - dy * ext };
      p2 = { x: p2.x + dx * ext, y: p2.y + dy * ext };
    }
    ctx.strokeStyle = line.color;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }
}

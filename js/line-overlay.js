// ライン描画オーバーレイ
//
// 線は「動画コンテンツ領域(object-fit: contain の実表示矩形)」に対する
// 正規化座標(0〜1)で保持する。カメラ固定前提なので、同じ正規化座標を
// ライブプレビューと全クリップの両方に適用すれば同じ位置に線が出る。
// 直線は端点2つを通る直線として画面端まで延長して描画する
// (シャフトプレーン用途では延長線の方が使いやすいため)。

const LINES_KEY = 'swing-check:lines';

export const LINE_COLORS = ['#38c17f', '#e5c04b', '#e05a5a', '#ffffff'];

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
   */
  constructor(wrap, video) {
    this.wrap = wrap;
    this.video = video;
    this.drawType = null;   // null | 'free' | 'v' | 'h'
    this.color = LINE_COLORS[0];
    this.dragStart = null;  // 描画中のドラッグ始点(正規化座標)
    this.dragCurrent = null;

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
    this.canvas.addEventListener('pointercancel', () => { this.dragStart = null; this.redraw(); });

    this.redraw();
  }

  /** 描画モードの設定。null で閲覧のみ(タッチ透過) */
  setDrawType(type) {
    this.drawType = type;
    this.canvas.classList.toggle('drawing', !!type);
    this.dragStart = null;
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

  _onDown(e) {
    if (!this.drawType) return;
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const p = this._toNorm(e);
    if (this.drawType === 'v') {
      lineStore.add({ type: 'v', x1: p.x, y1: 0, x2: p.x, y2: 1, color: this.color });
    } else if (this.drawType === 'h') {
      lineStore.add({ type: 'h', x1: 0, y1: p.y, x2: 1, y2: p.y, color: this.color });
    } else {
      this.dragStart = p;
      this.dragCurrent = p;
    }
  }

  _onMove(e) {
    if (!this.dragStart) return;
    e.preventDefault();
    this.dragCurrent = this._toNorm(e);
    this.redraw();
  }

  _onUp(e) {
    if (!this.dragStart) return;
    const end = this._toNorm(e);
    const s = this.dragStart;
    this.dragStart = null;
    // ほぼ動かないタップは誤操作として無視
    if (Math.hypot(end.x - s.x, end.y - s.y) > 0.02) {
      lineStore.add({ type: 'free', x1: s.x, y1: s.y, x2: end.x, y2: end.y, color: this.color });
    }
    this.redraw();
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
    // ドラッグ中のプレビュー
    if (this.dragStart && this.dragCurrent) {
      this._strokeLine(ctx, {
        type: 'free',
        x1: this.dragStart.x, y1: this.dragStart.y,
        x2: this.dragCurrent.x, y2: this.dragCurrent.y,
        color: this.color,
      }, toPx);
    }
    ctx.restore();
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

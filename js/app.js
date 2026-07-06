// アプリ統括: UI配線・セッション制御・リプレイ・保存一覧・PWA
import { loadSettings, saveSettings } from './settings.js';
import { RingRecorder } from './ring-recorder.js';
import { AudioDetector } from './audio-detector.js';
import { ClipStore } from './clip-store.js';
import { LineOverlay, lineStore, LINE_COLORS } from './line-overlay.js';

const $ = (sel) => document.querySelector(sel);

const settings = loadSettings();
const store = new ClipStore();

let stream = null;
let recorder = null;
let detector = null;
let wakeLock = null;
let capturing = false;

// 現在リプレイ中のクリップ
// { blob, url, startSec, endSec, impactOffsetSec, savedId(保存済みならid), createdAt }
let currentClip = null;

/* ================= ビュー切替 ================= */

document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === btn.dataset.view));
    if (btn.dataset.view === 'view-library') renderLibrary();
  });
});

/* ================= トースト ================= */

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2500);
}

/* ================= 設定UI ================= */

function bindRange(inputSel, valSel, key, fmt = (v) => v) {
  const input = $(inputSel);
  input.value = settings[key];
  if (valSel) $(valSel).textContent = fmt(settings[key]);
  input.addEventListener('input', () => {
    settings[key] = parseFloat(input.value);
    if (valSel) $(valSel).textContent = fmt(settings[key]);
    saveSettings(settings);
    if (key === 'threshold') updateThresholdMarkers();
  });
}

bindRange('#set-threshold', '#val-threshold', 'threshold', (v) => v.toFixed(2));
bindRange('#set-pre', '#val-pre', 'preSec');
bindRange('#set-post', '#val-post', 'postSec');
bindRange('#set-cooldown', '#val-cooldown', 'cooldownSec');

// 速度ボタンは設定画面とリプレイ画面の2箇所にあり、常に同期させる
const speedButtons = document.querySelectorAll('#speed-buttons .btn, #replay-speed-buttons .btn');
function renderSpeedButtons() {
  speedButtons.forEach((b) => b.classList.toggle('active', parseFloat(b.dataset.speed) === settings.speed));
}
speedButtons.forEach((b) => {
  b.addEventListener('click', () => {
    settings.speed = parseFloat(b.dataset.speed);
    saveSettings(settings);
    renderSpeedButtons();
    const rv = $('#replay-video');
    if (!$('#replay-overlay').classList.contains('hidden')) rv.playbackRate = settings.speed;
    $('#replay-speed-badge').textContent = settings.speed + 'x';
  });
});
renderSpeedButtons();

function updateThresholdMarkers() {
  document.querySelectorAll('.meter-threshold').forEach((el) => {
    el.style.left = `calc(${settings.threshold * 100}% - 1px)`;
  });
}
updateThresholdMarkers();

function updateMeters(level) {
  document.querySelectorAll('.meter').forEach((meter) => {
    const fill = meter.querySelector('.meter-fill');
    fill.style.width = `${Math.min(1, level) * 100}%`;
    fill.classList.toggle('over', level >= settings.threshold);
  });
}

/* ================= Wake Lock ================= */

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* 電池残量低下などで拒否されても続行 */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && stream) {
    acquireWakeLock();
    if (detector) detector.resume();
  }
});

/* ================= セッション ================= */

const statusText = $('#status-text');

/* ---- カメラズーム(対応端末のみ) ---- */

const zoomRow = $('#zoom-row');
const zoomSlider = $('#zoom-slider');
const zoomValue = $('#zoom-value');
let videoTrack = null;

function applyZoom(v) {
  if (!videoTrack) return;
  zoomValue.textContent = '×' + Number(v).toFixed(1);
  videoTrack.applyConstraints({ advanced: [{ zoom: v }] })
    .catch(() => videoTrack.applyConstraints({ zoom: v }).catch(() => {}));
}

function setupZoom() {
  videoTrack = stream.getVideoTracks()[0];
  const caps = videoTrack.getCapabilities ? videoTrack.getCapabilities() : {};
  if (!caps.zoom || caps.zoom.max <= caps.zoom.min) {
    zoomRow.classList.add('hidden');
    return;
  }
  zoomSlider.min = caps.zoom.min;
  zoomSlider.max = caps.zoom.max;
  zoomSlider.step = caps.zoom.step || 0.1;
  const current = (videoTrack.getSettings && videoTrack.getSettings().zoom) || caps.zoom.min;
  // 保存済みズームがあれば復元(範囲内にクランプ)
  const initial = settings.zoom
    ? Math.min(caps.zoom.max, Math.max(caps.zoom.min, settings.zoom))
    : current;
  zoomSlider.value = initial;
  applyZoom(initial);
  zoomRow.classList.remove('hidden');
}

zoomSlider.addEventListener('input', () => {
  const v = parseFloat(zoomSlider.value);
  applyZoom(v);
  settings.zoom = v;
  saveSettings(settings);
});

async function startSession() {
  $('#start-error').textContent = '';
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 60 },
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch (e) {
    $('#start-error').textContent =
      'カメラ/マイクを開始できませんでした。\nブラウザの権限設定を確認してください。\n(' + e.name + ')';
    return;
  }

  $('#preview').srcObject = stream;
  setupZoom();

  // セグメント長は「インパクト前秒数+余裕」。セッション中の preSec 変更は次回セッションから反映
  recorder = new RingRecorder(stream, Math.max(4, settings.preSec + 2));
  recorder.start();

  detector = new AudioDetector(stream, {
    getThreshold: () => settings.threshold,
    getCooldownSec: () => settings.cooldownSec,
    onLevel: updateMeters,
    onImpact: () => captureClip(),
  });
  await detector.start();

  await acquireWakeLock();

  $('#idle-cover').classList.add('hidden');
  $('#session-hud').classList.remove('hidden');
  statusText.textContent = '監視中';
  statusText.classList.add('recording');
}

function stopSession() {
  if (detector) { detector.stop(); detector = null; }
  if (recorder) { recorder.stop(); recorder = null; }
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  videoTrack = null;
  zoomRow.classList.add('hidden');
  $('#preview').srcObject = null;
  $('#idle-cover').classList.remove('hidden');
  $('#session-hud').classList.add('hidden');
  statusText.classList.remove('recording');
  updateMeters(0);
}

$('#btn-start').addEventListener('click', startSession);
$('#btn-stop').addEventListener('click', () => {
  closeReplay();
  stopSession();
});
$('#btn-manual').addEventListener('click', () => captureClip());

/* ================= クリップ切り出し ================= */

async function captureClip() {
  if (!recorder || capturing) return;
  capturing = true;
  statusText.textContent = '切り出し中…';
  try {
    const result = await recorder.capture(settings.postSec);
    if (!result) return;
    const { blob, impactOffsetSec } = result;
    // 前のリプレイ(未保存クリップ)は自動破棄して差し替える
    discardCurrentClip();
    currentClip = {
      blob,
      url: URL.createObjectURL(blob),
      impactOffsetSec,
      startSec: Math.max(0, impactOffsetSec - settings.preSec),
      endSec: impactOffsetSec + settings.postSec,
      savedId: null,
      createdAt: Date.now(),
    };
    openReplay(currentClip, /*savedMode*/ false);
  } catch (e) {
    toast('切り出しに失敗しました: ' + e.message);
  } finally {
    capturing = false;
    statusText.textContent = '監視中';
  }
}

/* ================= リプレイ ================= */

const overlay = $('#replay-overlay');
const replayVideo = $('#replay-video');
const seekBar = $('#replay-seek');
let replaying = null; // 再生中のクリップ情報 {startSec, endSec}
let seekDragging = false;

function openReplay(clip, savedMode) {
  replaying = clip;
  overlay.classList.remove('hidden');
  $('#replay-buttons-new').classList.toggle('hidden', savedMode);
  $('#replay-buttons-saved').classList.toggle('hidden', !savedMode);
  $('#replay-paused-badge').classList.add('hidden');
  $('#replay-speed-badge').textContent = settings.speed + 'x';
  seekBar.value = 0;

  replayVideo.src = clip.url;
  replayVideo.playbackRate = settings.speed;
  replayVideo.onloadedmetadata = () => {
    // 一部ブラウザで blob 動画の duration が Infinity になる対策
    if (!isFinite(replayVideo.duration)) {
      replayVideo.currentTime = 1e7;
      replayVideo.ontimeupdate = () => {
        replayVideo.ontimeupdate = null;
        startReplayLoop(clip);
      };
      return;
    }
    startReplayLoop(clip);
  };
}

function startReplayLoop(clip) {
  const dur = isFinite(replayVideo.duration) ? replayVideo.duration : clip.endSec;
  clip.playStart = Math.min(clip.startSec, Math.max(0, dur - 0.1));
  clip.playEnd = Math.min(clip.endSec, dur);
  replayVideo.currentTime = clip.playStart;
  replayVideo.playbackRate = settings.speed;
  replayVideo.play().catch(() => {});
}

// 区間ループ+シークバー更新
setInterval(() => {
  if (!replaying || overlay.classList.contains('hidden')) return;
  const { playStart = 0, playEnd = 0 } = replaying;
  if (playEnd <= playStart) return;
  if (!replayVideo.paused && replayVideo.currentTime >= playEnd - 0.05) {
    replayVideo.currentTime = playStart;
  }
  if (!seekDragging) {
    const p = (replayVideo.currentTime - playStart) / (playEnd - playStart);
    seekBar.value = Math.round(Math.min(1, Math.max(0, p)) * 1000);
  }
}, 50);

// タップで一時停止/再開
replayVideo.addEventListener('click', () => {
  if (replayVideo.paused) {
    replayVideo.play().catch(() => {});
    $('#replay-paused-badge').classList.add('hidden');
  } else {
    replayVideo.pause();
    $('#replay-paused-badge').classList.remove('hidden');
  }
});

// シーク(ドラッグ中は一時停止してコマ送り)
seekBar.addEventListener('input', () => {
  if (!replaying) return;
  seekDragging = true;
  replayVideo.pause();
  $('#replay-paused-badge').classList.remove('hidden');
  const { playStart = 0, playEnd = 0 } = replaying;
  replayVideo.currentTime = playStart + (seekBar.value / 1000) * (playEnd - playStart);
});
seekBar.addEventListener('change', () => { seekDragging = false; });

/* ================= ライン描画 ================= */

// ライブプレビューは表示のみ、リプレイ画面では描画も可能
new LineOverlay($('.camera-wrap'), $('#preview'));
const replayLines = new LineOverlay($('.replay-video-wrap'), replayVideo);

const lineToolbar = $('#line-toolbar');
const lineModeBtn = $('#btn-line-mode');
const lineTypeButtons = document.querySelectorAll('#line-toolbar [data-linetype]');
let lineColorIndex = 0;

function setLineType(type) {
  replayLines.setDrawType(type);
  lineTypeButtons.forEach((b) => b.classList.toggle('active', b.dataset.linetype === type));
}

function exitLineMode() {
  lineToolbar.classList.add('hidden');
  lineModeBtn.classList.remove('active');
  setLineType(null);
}

lineModeBtn.addEventListener('click', () => {
  const opening = lineToolbar.classList.contains('hidden');
  if (opening) {
    lineToolbar.classList.remove('hidden');
    lineModeBtn.classList.add('active');
    setLineType('free');
  } else {
    exitLineMode();
  }
});

lineTypeButtons.forEach((b) => {
  b.addEventListener('click', () => setLineType(b.dataset.linetype));
});

const lineColorBtn = $('#btn-line-color');
function applyLineColor() {
  const color = LINE_COLORS[lineColorIndex];
  replayLines.setColor(color);
  lineColorBtn.style.background = color;
  lineColorBtn.style.color = '#0d1512';
}
lineColorBtn.addEventListener('click', () => {
  lineColorIndex = (lineColorIndex + 1) % LINE_COLORS.length;
  applyLineColor();
});
applyLineColor();

$('#btn-line-clear').addEventListener('click', () => {
  lineStore.clear();
  toast('線を全て消去しました');
});

function closeReplay() {
  overlay.classList.add('hidden');
  exitLineMode();
  replayVideo.pause();
  replayVideo.removeAttribute('src');
  replayVideo.load();
  discardCurrentClip();
  replaying = null;
}

function discardCurrentClip() {
  // 保存済みでも blob は IndexedDB 側にあるので URL は常に破棄してよい
  if (currentClip) URL.revokeObjectURL(currentClip.url);
  currentClip = null;
}

/* ================= 保存・破棄・エクスポート ================= */

function makeThumbnail() {
  try {
    const canvas = document.createElement('canvas');
    const w = 192;
    const h = Math.round(w * (replayVideo.videoHeight / replayVideo.videoWidth)) || 108;
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(replayVideo, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return '';
  }
}

$('#btn-save-clip').addEventListener('click', async () => {
  if (!currentClip || currentClip.savedId) return;
  const clip = currentClip;
  try {
    const id = await store.add({
      createdAt: clip.createdAt,
      mimeType: clip.blob.type,
      startSec: clip.playStart ?? clip.startSec,
      endSec: clip.playEnd ?? clip.endSec,
      impactOffsetSec: clip.impactOffsetSec,
      sizeBytes: clip.blob.size,
      thumb: makeThumbnail(),
    }, clip.blob);
    clip.savedId = id;
    toast('保存しました');
    // 保存後はエクスポート/削除/閉じる操作に切り替え
    $('#replay-buttons-new').classList.add('hidden');
    $('#replay-buttons-saved').classList.remove('hidden');
  } catch (e) {
    toast('保存に失敗しました: ' + e.message);
  }
});

$('#btn-discard-clip').addEventListener('click', closeReplay);
$('#btn-close-replay').addEventListener('click', closeReplay);

$('#btn-delete-clip').addEventListener('click', async () => {
  if (!currentClip || !currentClip.savedId) { closeReplay(); return; }
  if (!confirm('このクリップを削除しますか?')) return;
  await store.delete(currentClip.savedId);
  toast('削除しました');
  closeReplay();
  renderLibrary();
});

$('#btn-export-clip').addEventListener('click', async () => {
  if (!currentClip) return;
  await exportClip(currentClip.blob, currentClip.createdAt);
});

function clipFileName(createdAt, mimeType) {
  const d = new Date(createdAt);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const ext = (mimeType || '').includes('mp4') ? 'mp4' : 'webm';
  return `swing_${stamp}.${ext}`;
}

async function exportClip(blob, createdAt) {
  const name = clipFileName(createdAt, blob.type);
  // iOS では共有シート経由が「写真に保存」につながるため share を優先
  if (navigator.canShare) {
    try {
      const file = new File([blob], name, { type: blob.type });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    } catch (e) {
      if (e.name === 'AbortError') return; // ユーザーがキャンセル
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/* ================= 保存一覧 ================= */

function formatDate(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return Math.round(bytes / 1e3) + ' KB';
}

async function renderLibrary() {
  const items = await store.list();
  const list = $('#clip-list');
  list.innerHTML = '';
  $('#library-empty').classList.toggle('hidden', items.length > 0);

  for (const meta of items) {
    const li = document.createElement('li');
    li.className = 'clip-item';
    li.innerHTML = `
      <img class="clip-thumb" alt="">
      <div class="clip-info">
        <div class="clip-date"></div>
        <div class="clip-size"></div>
      </div>
      <div class="clip-actions">
        <button class="btn btn-small btn-danger">削除</button>
      </div>`;
    if (meta.thumb) li.querySelector('.clip-thumb').src = meta.thumb;
    li.querySelector('.clip-date').textContent = formatDate(meta.createdAt);
    li.querySelector('.clip-size').textContent = formatBytes(meta.sizeBytes);

    li.querySelector('.clip-thumb').addEventListener('click', () => playSavedClip(meta));
    li.querySelector('.clip-info').addEventListener('click', () => playSavedClip(meta));
    li.querySelector('.btn-danger').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('このクリップを削除しますか?')) return;
      await store.delete(meta.id);
      renderLibrary();
    });
    list.appendChild(li);
  }

  const est = await store.estimate();
  $('#storage-usage').textContent = est
    ? `使用中 ${formatBytes(est.usage || 0)} / 空き目安 ${formatBytes((est.quota || 0) - (est.usage || 0))}`
    : '';
}

async function playSavedClip(meta) {
  const blob = await store.getBlob(meta.id);
  if (!blob) { toast('動画データが見つかりません'); return; }
  discardCurrentClip();
  currentClip = {
    blob,
    url: URL.createObjectURL(blob),
    impactOffsetSec: meta.impactOffsetSec,
    startSec: meta.startSec,
    endSec: meta.endSec,
    savedId: meta.id,
    createdAt: meta.createdAt,
  };
  openReplay(currentClip, /*savedMode*/ true);
}

/* ================= Service Worker ================= */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
  // 新バージョンのSWが有効になったら自動リロードして即反映する
  // (初回インストール時とセッション中は除く。セッション中のリロードは録画が切れる)
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded || stream) return;
    reloaded = true;
    location.reload();
  });
}

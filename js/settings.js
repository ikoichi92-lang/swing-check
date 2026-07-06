// 設定の保存・復元(localStorage)

const STORAGE_KEY = 'swing-check:settings';

export const DEFAULT_SETTINGS = {
  threshold: 0.35,   // 音量しきい値(0〜1、時間波形のピーク振幅)
  preSec: 3,         // インパクト前の切り出し秒数
  postSec: 2,        // インパクト後の切り出し秒数
  cooldownSec: 5,    // 検知クールダウン秒数
  speed: 0.5,        // リプレイ再生速度
  zoom: 0,           // カメラズーム(0 = 端末デフォルトのまま)
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // プライベートブラウズ等で失敗しても動作は継続
  }
}

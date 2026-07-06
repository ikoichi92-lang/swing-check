# Swing Check

ゴルフ練習用のスイング自動撮影PWA。スマホを三脚に固定してセッションを開始すると、打球音を検知して直前数秒のスイング映像を自動で切り出し、その場でスローリプレイを表示する。

- 対応端末: iPhone(Safari)最優先 / Android Chrome
- サーバー不要。動画は端末内(IndexedDB)のみに保存し、外部送信は一切しない
- 要件の詳細は [REQUIREMENTS.md](REQUIREMENTS.md) を参照

## 使い方

1. https://ikoichi92-lang.github.io/swing-check/ をiPhoneのSafariで開く
2. 共有メニュー →「ホーム画面に追加」でインストール(推奨)
3. スマホを三脚に固定し、スイングが写る位置に置く(横持ち推奨)
4. 「セッション開始」→ カメラ・マイクを許可
5. 設定画面で音量しきい値を調整(手を叩いてメーターがしきい値の縦線を超えることを確認)
6. ボールを打つと自動でスローリプレイが表示される。「保存」で端末に保存、放置すれば次のショットで自動的に差し替わる

## 実装方式の選定理由(iOS Safari対応)

### リングバッファ録画: MediaRecorder 二重セグメント方式

「直近N秒を常に保持する」ための方式は3つ検討した。

1. **MediaRecorder + timeslice で古いチャンクを捨てる** — iOS Safari(および多くのブラウザ)では、timeslice分割されたチャンクは先頭チャンクの初期化セグメントに依存しており、先頭を捨てると残りが再生不能になる。❌
2. **フレームバッファ方式(ImageBitmap/canvas蓄積)** — 720p×5秒×30fpsで数百MBとなりiOSのメモリ制約を超える。再エンコードも必要。❌
3. **MediaRecorder を一定間隔で多重起動(採用)** — segment秒ごとに新しいMediaRecorderを起動し常に最大2本を並走させる。各レコーダーはstart〜stopの完全な動画ファイルを生成するため単体再生可能。最古のレコーダーは常にsegment秒以上の過去映像を保持している。インパクト検知時は「後Y秒」だけ録り足して停止し、blobと「blob内でのインパクト時刻オフセット」を得る。実際の再生区間(前X秒〜後Y秒)は再生側が制御する。✅

### その他のiOS対応

- **コーデック**: `MediaRecorder.isTypeSupported()` で `video/mp4;codecs=avc1(H.264)` を最優先に選択(iOSはWebM非対応)。Android等はWebMにフォールバック
- **AudioContext**: iOSではユーザー操作後にしか開始できないため、「セッション開始」ボタンのタップハンドラ内で生成・resumeする
- **音声処理の無効化**: `echoCancellation` / `noiseSuppression` / `autoGainControl` をオフにして打球音のスパイクが潰されないようにする
- **画面消灯防止**: Wake Lock API(iOS 16.4+)。`visibilitychange` で復帰時に再取得
- **blob動画のduration=Infinity対策**: メタデータ読込後に `currentTime` を大きな値に飛ばして実durationを確定させる
- **エクスポート**: iOSでは `<a download>` より共有シート(`navigator.share` + files)の方が「写真に保存」に繋がるため、Web Share API を優先しフォールバックでダウンロードリンクを使用

## ローカル開発

カメラ/マイクはHTTPSまたはlocalhostが必須。ビルドツールは不要で、静的サーバーを立てるだけでよい。

```sh
# どちらか
python -m http.server 8000
npx serve .
```

`http://localhost:8000` を開く。実機(iPhone)で試す場合はGitHub Pagesへpushするのが最も簡単。

## GitHub Pages 公開手順

1. GitHubリポジトリ https://github.com/ikoichi92-lang/swing-check にpush
2. リポジトリの **Settings → Pages** を開く
3. 「Build and deployment」の Source を **Deploy from a branch** にする
4. Branch で **main** / **/(root)** を選択して Save
5. 数分後 https://ikoichi92-lang.github.io/swing-check/ で公開される

※ アプリ更新時は `sw.js` の `CACHE_NAME` のバージョンを上げること(オフラインキャッシュが更新される)。

## ファイル構成

```
index.html          UI(撮影 / 保存一覧 / 設定 / リプレイオーバーレイ)
css/style.css
js/app.js           統括(セッション制御・リプレイ・保存一覧・PWA登録)
js/ring-recorder.js リングバッファ録画(二重セグメント方式)
js/audio-detector.js 打球音検知(Web Audio)
js/clip-store.js    クリップ保存(IndexedDB)
js/settings.js      設定の保存・復元(localStorage)
sw.js               Service Worker(オフラインキャッシュ)
manifest.json       PWAマニフェスト
icons/              アプリアイコン
```

## Phase 2(拡張予定)

シャフトプレーン自動検出、任意ライン描画、Vゾーン表示、2動画同期比較。[REQUIREMENTS.md](REQUIREMENTS.md) 参照。

// クリップ保存(IndexedDB)
//
// メタデータ(サムネイル含む)と動画 blob を別ストアに分け、
// 一覧表示時に全動画をメモリへ読み込まずに済むようにする。

const DB_NAME = 'swing-check';
const DB_VERSION = 1;
const META_STORE = 'clips';
const BLOB_STORE = 'blobs';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        db.createObjectStore(BLOB_STORE); // key = clip id
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

export class ClipStore {
  async _db() {
    if (!this.dbPromise) this.dbPromise = openDb();
    return this.dbPromise;
  }

  /**
   * @param {{createdAt:number, mimeType:string, startSec:number, endSec:number,
   *          impactOffsetSec:number, sizeBytes:number, thumb:string}} meta
   * @param {Blob} blob
   * @returns {Promise<number>} 採番された id
   */
  async add(meta, blob) {
    const db = await this._db();
    const tx = db.transaction([META_STORE, BLOB_STORE], 'readwrite');
    const id = await new Promise((resolve, reject) => {
      const req = tx.objectStore(META_STORE).add(meta);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    tx.objectStore(BLOB_STORE).put(blob, id);
    await txDone(tx);
    return id;
  }

  /** 新しい順のメタデータ一覧(blob は含まない) */
  async list() {
    const db = await this._db();
    const tx = db.transaction(META_STORE, 'readonly');
    const items = await new Promise((resolve, reject) => {
      const req = tx.objectStore(META_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    return items.sort((a, b) => b.createdAt - a.createdAt);
  }

  async getBlob(id) {
    const db = await this._db();
    const tx = db.transaction(BLOB_STORE, 'readonly');
    return new Promise((resolve, reject) => {
      const req = tx.objectStore(BLOB_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async delete(id) {
    const db = await this._db();
    const tx = db.transaction([META_STORE, BLOB_STORE], 'readwrite');
    tx.objectStore(META_STORE).delete(id);
    tx.objectStore(BLOB_STORE).delete(id);
    await txDone(tx);
  }

  /** ストレージ使用量の目安 {usage, quota}(バイト、取得不可なら null) */
  async estimate() {
    if (navigator.storage && navigator.storage.estimate) {
      try { return await navigator.storage.estimate(); } catch { /* ignore */ }
    }
    return null;
  }
}

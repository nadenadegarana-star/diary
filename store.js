// 日記データの保存層。画面(app.js)はIndexedDBを直接触らず、ここの関数だけを使う。
// 将来の同期処理(Sync Engine)もここの上に載せる。
//
// entry: { id, date: 'YYYY-MM-DD', text, updatedAt: ISO文字列, deletedAt: ISO文字列|null, deviceId }
// id は常に date と同じ（1日1件なので日付そのものが全端末共通のキー）。
// 削除は物理削除せず deletedAt を入れる（別端末に「消した」ことを伝えるため）。
// 削除記録は消さない（古い端末が復帰したときに、消した日記が復活するのを防ぐ）。

const Store = (() => {
  const DB_NAME = 'diary';
  const DB_VERSION = 2; // = schemaVersion
  let db;
  let deviceId;

  // ---- 低レベル ----
  const reqP = (r) => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const txDone = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

  function open() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = (e) => {
        const d = r.result;
        const tx = r.transaction;
        if (e.oldVersion < 1) d.createObjectStore('entries', { keyPath: 'date' });
        if (e.oldVersion < 2) {
          d.createObjectStore('metadata', { keyPath: 'key' });
          // v1 → v2: updatedAt を数値からISO文字列へ、id/deletedAt を追加
          tx.objectStore('entries').openCursor().onsuccess = (ev) => {
            const cur = ev.target.result;
            if (!cur) return;
            const v = cur.value;
            const t = new Date(v.updatedAt);
            cur.update({
              id: v.date,
              date: v.date,
              text: typeof v.text === 'string' ? v.text : String(v.text ?? ''),
              updatedAt: (isNaN(t) ? new Date(0) : t).toISOString(), // 不正な日時は最古扱い（他端末の版に負ける）
              deletedAt: null,
              deviceId: v.deviceId || '',
            });
            cur.continue();
          };
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      // 別タブが古い版を開いたままだと待たされる。失敗にはせず、閉じられたら続行する
      r.onblocked = () => api.onBlocked && api.onBlocked();
    });
  }

  async function init() {
    db = await open();
    // 別タブで新しい版が開かれたら、未保存分を保存してから閉じ、新しい版で開き直す
    db.onversionchange = async () => {
      try { if (api.beforeClose) await api.beforeClose(); } finally { db.close(); location.reload(); }
    };
    const tx = db.transaction('metadata', 'readwrite');
    const meta = tx.objectStore('metadata');
    const saved = await reqP(meta.get('deviceId'));
    deviceId = saved ? saved.value : crypto.randomUUID();
    meta.put({ key: 'deviceId', value: deviceId });
    meta.put({ key: 'schemaVersion', value: DB_VERSION });
    await txDone(tx);
  }

  // 同じ日付の2件のうち、どちらを正とするか（LWW）。a が勝てば正の数。
  // updatedAt → deviceId の順で比べ、どの端末でも同じ結果になるようにする。
  function compare(a, b) {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? 1 : -1;
    if ((a.deviceId || '') !== (b.deviceId || '')) return (a.deviceId || '') > (b.deviceId || '') ? 1 : -1;
    return 0;
  }

  // ---- 公開API ----
  async function loadEntry(date) {
    const e = await reqP(db.transaction('entries').objectStore('entries').get(date));
    return e && !e.deletedAt ? e : null;
  }

  async function saveEntry(date, text) {
    if (!text.trim()) return deleteEntry(date);
    const entry = { id: date, date, text, updatedAt: new Date().toISOString(), deletedAt: null, deviceId };
    const tx = db.transaction('entries', 'readwrite');
    tx.objectStore('entries').put(entry);
    await txDone(tx);
    return entry;
  }

  async function deleteEntry(date) {
    const tx = db.transaction('entries', 'readwrite');
    const s = tx.objectStore('entries');
    const cur = await reqP(s.get(date));
    if (cur && !cur.deletedAt) {
      const now = new Date().toISOString();
      s.put({ id: date, date, text: '', updatedAt: now, deletedAt: now, deviceId });
    }
    await txDone(tx);
    return null;
  }

  async function listDates() {
    const all = await reqP(db.transaction('entries').objectStore('entries').getAll());
    return all.filter((e) => !e.deletedAt).map((e) => e.date);
  }

  // 削除記録も含めた全件（バックアップ・同期用）
  const allEntries = () => reqP(db.transaction('entries').objectStore('entries').getAll());

  // ---- バックアップ ----
  function isValidDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }
  function toISO(v) {
    // v1のバックアップは数値(ミリ秒)なので両方受け付ける
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    const t = new Date(v);
    return isNaN(t) ? null : t.toISOString();
  }

  // JSON文字列を検証して、取り込める entry の配列と不正件数を返す。例外は投げない。
  function parseBackup(jsonText) {
    let data;
    try { data = JSON.parse(jsonText); } catch { return { error: 'JSONとして読めません。' }; }
    if (!data || !Array.isArray(data.entries)) return { error: '日記のバックアップ形式ではありません。' };
    // 新しい版のアプリで作ったバックアップは、この版では正しく扱えないので拒否する
    if (typeof data.schemaVersion === 'number' && data.schemaVersion > DB_VERSION) {
      return { error: 'このバックアップは新しい版のアプリで作られています。アプリを更新してから読み込んでください。' };
    }
    const MAX_TEXT = 200000; // 1日分の本文の上限（文字数）
    const latest = new Date(Date.now() + 24 * 3600e3).toISOString(); // 1日以上先の日時は不正とみなす
    const entries = new Map();
    let invalid = 0;
    for (const e of data.entries) {
      const updatedAt = e && toISO(e.updatedAt);
      const deletedAt = e && e.deletedAt != null ? toISO(e.deletedAt) : null;
      if (!e || !isValidDate(e.date) || typeof e.text !== 'string' || e.text.length > MAX_TEXT ||
          !updatedAt || updatedAt > latest || (e.deletedAt != null && !deletedAt)) {
        invalid++;
        continue;
      }
      // 必要な項目だけを取り出して作り直す（未知の項目は持ち込まない）
      const deviceId = typeof e.deviceId === 'string' && /^[\w-]{0,64}$/.test(e.deviceId) ? e.deviceId : '';
      const entry = { id: e.date, date: e.date, text: deletedAt ? '' : e.text, updatedAt, deletedAt, deviceId };
      const dup = entries.get(e.date);
      if (!dup || compare(entry, dup) > 0) entries.set(e.date, entry);
    }
    const list = [...entries.values()];
    return { entries: list, live: list.filter((e) => !e.deletedAt).length, invalid };
  }

  // mode: 'merge'（新しい方を残す）| 'replace'（今のデータを全部入れ替える）
  // 1つのトランザクションで行うので、途中で失敗したら何も変わらない。
  async function importEntries(entries, mode) {
    const tx = db.transaction('entries', 'readwrite');
    const done = txDone(tx);
    const s = tx.objectStore('entries');
    let changed = 0;
    try {
      const current = new Map();
      if (mode === 'replace') s.clear();
      else for (const e of await reqP(s.getAll())) current.set(e.date, e);
      for (const e of entries) {
        const cur = current.get(e.date);
        if (!cur || compare(e, cur) > 0) { s.put(e); changed++; }
      }
    } catch (err) {
      try { tx.abort(); } catch {} // 途中で失敗したら全部取り消す
      await done.catch(() => {});
      throw err;
    }
    await done;
    return changed;
  }

  async function exportJSON() {
    return JSON.stringify({ app: 'diary', schemaVersion: DB_VERSION, exportedAt: new Date().toISOString(), entries: await allEntries() }, null, 2);
  }

  // beforeClose: 閉じる前に呼ぶ保存処理 / onBlocked: 別タブ待ちのとき呼ぶ（どちらも画面側が設定する）
  const api = { init, loadEntry, saveEntry, deleteEntry, listDates, allEntries, parseBackup, importEntries, exportJSON, compare, beforeClose: null, onBlocked: null };
  return api;
})();

// 日記データの保存層。画面(app.js)はIndexedDBを直接触らず、ここの関数だけを使う。
// 将来の同期処理(Sync Engine)もここの上に載せる。
//
// entry: { id, date: 'YYYY-MM-DD', text, mood: MOODのキー|null, audio: [clip], updatedAt: ISO, deletedAt: ISO|null, deviceId }
// clip : { id, createdAt: ISO, duration: 秒, mime, peaks: [0-1の数値], transcript: 文字起こしの原文|null }
// 音声本体は 'audio' ストアに { id, date, blob } で別に置く（日記一覧を軽く保つため）。
//
// id は常に date と同じ（1日1件なので日付そのものが全端末共通のキー）。
// 削除は物理削除せず deletedAt を入れる（別端末に「消した」ことを伝えるため）。
// 削除記録は消さない（古い端末が復帰したときに、消した日記が復活するのを防ぐ）。

const Store = (() => {
  const DB_NAME = 'diary';
  const DB_VERSION = 3; // = schemaVersion
  const MOODS = ['happy', 'calm', 'normal', 'tired', 'moody', 'down'];
  const MAX_TEXT = 200000; // 1日分の本文の上限（文字数）
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
  const nowISO = () => new Date().toISOString();
  function isoOrEpoch(v) {
    const t = new Date(v);
    return (isNaN(t) ? new Date(0) : t).toISOString(); // 不正な日時は最古扱い（他端末の版に負ける）
  }

  // 古い版のデータを今の形にそろえる（v1: updatedAtが数値 / v2: mood・audioなし）
  function normalize(v) {
    return {
      id: v.date,
      date: v.date,
      text: typeof v.text === 'string' ? v.text : String(v.text ?? ''),
      mood: MOODS.includes(v.mood) ? v.mood : null,
      audio: Array.isArray(v.audio) ? v.audio : [],
      updatedAt: isoOrEpoch(v.updatedAt),
      deletedAt: v.deletedAt ? isoOrEpoch(v.deletedAt) : null,
      deviceId: typeof v.deviceId === 'string' ? v.deviceId : '',
    };
  }

  function open() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = (e) => {
        const d = r.result;
        const old = e.oldVersion;
        if (old < 1) d.createObjectStore('entries', { keyPath: 'date' });
        if (old < 2) d.createObjectStore('metadata', { keyPath: 'key' });
        if (old < 3) d.createObjectStore('audio', { keyPath: 'id' });
        if (old >= 1 && old < 3) {
          r.transaction.objectStore('entries').openCursor().onsuccess = (ev) => {
            const cur = ev.target.result;
            if (!cur) return;
            cur.update(normalize(cur.value));
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
  function compare(a, b) {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? 1 : -1;
    if ((a.deviceId || '') !== (b.deviceId || '')) return (a.deviceId || '') > (b.deviceId || '') ? 1 : -1;
    return 0;
  }

  const blank = (date) => ({ id: date, date, text: '', mood: null, audio: [], updatedAt: '', deletedAt: null, deviceId });
  const isEmpty = (e) => !e.text.trim() && !e.mood && e.audio.length === 0;
  const tombstone = (date) => { const t = nowISO(); return { ...blank(date), updatedAt: t, deletedAt: t }; };

  // 書き込み用トランザクションを開き、fn(stores) の中で行った変更をまとめて確定する。
  // 途中で失敗したら全部取り消す。
  async function write(storeNames, fn) {
    const tx = db.transaction(storeNames, 'readwrite');
    const done = txDone(tx);
    const stores = Object.fromEntries(storeNames.map((n) => [n, tx.objectStore(n)]));
    let result;
    try {
      result = await fn(stores);
    } catch (err) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw err;
    }
    await done;
    return result;
  }

  // 取り出した現在の entry に変更を加えて保存する。中身が空になったら削除記録にする。
  async function modify(s, date, change) {
    const cur = await reqP(s.entries.get(date));
    const base = cur && !cur.deletedAt ? { ...cur, audio: [...cur.audio] } : blank(date);
    const next = { ...base, ...change(base), id: date, date, updatedAt: nowISO(), deletedAt: null, deviceId };
    if (isEmpty(next)) {
      if (!cur || cur.deletedAt) return null; // もともと無い日なら何もしない
      s.entries.put(tombstone(date));
      return null;
    }
    s.entries.put(next);
    return next;
  }

  // ---- 公開API ----
  async function loadEntry(date) {
    const e = await reqP(db.transaction('entries').objectStore('entries').get(date));
    return e && !e.deletedAt ? e : null;
  }

  // patch: { text?, mood? }。保存後の entry（空になったら null）を返す。
  function updateEntry(date, patch) {
    return write(['entries'], (s) => modify(s, date, () => {
      const p = {};
      if (typeof patch.text === 'string') p.text = patch.text;
      if ('mood' in patch) p.mood = MOODS.includes(patch.mood) ? patch.mood : null;
      return p;
    }));
  }

  // 録音を1件追加し、文字起こし(text)があれば本文の末尾に追記する。1トランザクションで行う。
  function addRecording(date, blob, meta, text) {
    const clip = {
      id: meta.id || crypto.randomUUID(),
      createdAt: nowISO(),
      duration: Math.round(meta.duration * 10) / 10,
      mime: blob.type || meta.mime || '',
      peaks: meta.peaks || [],
      transcript: meta.transcript ?? null,
    };
    return write(['entries', 'audio'], async (s) => {
      s.audio.put({ id: clip.id, date, blob });
      return modify(s, date, (e) => ({
        audio: [...e.audio, clip],
        text: text && text.trim() ? (e.text.trim() ? e.text.replace(/\s+$/, '') + '\n\n' : '') + text.trim() : e.text,
      }));
    });
  }

  // あとから文字起こしした結果を clip に記録し、本文に追記する。
  // その録音が残っていて、まだ文字起こし結果が入っていないときだけ反映する
  // （処理中に録音や日記が消された場合の復活や、二重の追記を防ぐ）。
  function setTranscript(date, clipId, transcript, appendText) {
    return write(['entries'], async (s) => {
      const cur = await reqP(s.entries.get(date));
      const live = cur && !cur.deletedAt ? cur : null;
      const clip = live && live.audio.find((c) => c.id === clipId);
      if (!clip || clip.transcript != null) return live;
      return modify(s, date, (e) => ({
        audio: e.audio.map((c) => (c.id === clipId ? { ...c, transcript } : c)),
        text: appendText && transcript.trim() ? (e.text.trim() ? e.text.replace(/\s+$/, '') + '\n\n' : '') + transcript.trim() : e.text,
      }));
    });
  }

  function removeRecording(date, clipId) {
    return write(['entries', 'audio'], (s) => {
      s.audio.delete(clipId);
      return modify(s, date, (e) => ({ audio: e.audio.filter((c) => c.id !== clipId) }));
    });
  }

  async function getAudio(clipId) {
    const r = await reqP(db.transaction('audio').objectStore('audio').get(clipId));
    return r ? r.blob : null;
  }

  function deleteEntry(date) {
    return write(['entries', 'audio'], async (s) => {
      const cur = await reqP(s.entries.get(date));
      if (!cur || cur.deletedAt) return null;
      for (const c of cur.audio) s.audio.delete(c.id);
      s.entries.put(tombstone(date));
      return null;
    });
  }

  // 削除されていない日記すべて（音声本体は含まない）
  async function listEntries() {
    const all = await reqP(db.transaction('entries').objectStore('entries').getAll());
    return all.filter((e) => !e.deletedAt);
  }

  // 削除記録も含めた全件（バックアップ・同期用）
  const allEntries = () => reqP(db.transaction('entries').objectStore('entries').getAll());

  // ---- バックアップ（本文・気分・音声の情報。音声本体は含まない） ----
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
  const isId = (v) => typeof v === 'string' && /^[\w-]{1,64}$/.test(v);
  function cleanClip(c) {
    if (!c || !isId(c.id) || !toISO(c.createdAt) || typeof c.duration !== 'number' || !(c.duration >= 0)) return null;
    return {
      id: c.id,
      createdAt: toISO(c.createdAt),
      duration: c.duration,
      mime: typeof c.mime === 'string' ? c.mime.slice(0, 100) : '',
      peaks: Array.isArray(c.peaks) ? c.peaks.slice(0, 200).map((n) => Math.min(1, Math.max(0, Number(n) || 0))) : [],
      transcript: typeof c.transcript === 'string' ? c.transcript.slice(0, MAX_TEXT) : null,
    };
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
      const entry = {
        id: e.date,
        date: e.date,
        text: deletedAt ? '' : e.text,
        mood: !deletedAt && MOODS.includes(e.mood) ? e.mood : null,
        audio: !deletedAt && Array.isArray(e.audio) ? e.audio.map(cleanClip).filter(Boolean) : [],
        updatedAt,
        deletedAt,
        deviceId: typeof e.deviceId === 'string' && /^[\w-]{0,64}$/.test(e.deviceId) ? e.deviceId : '',
      };
      const dup = entries.get(e.date);
      if (!dup || compare(entry, dup) > 0) entries.set(e.date, entry);
    }
    const list = [...entries.values()];
    // 同じ録音IDが複数の日記に出てきたら、最初の1件だけ残す（別の日の音声を指すのを防ぐ）
    const seen = new Set();
    for (const e of list) e.audio = e.audio.filter((c) => !seen.has(c.id) && seen.add(c.id));
    return { entries: list, live: list.filter((e) => !e.deletedAt).length, invalid };
  }

  // mode: 'merge'（新しい方を残す）| 'replace'（今のデータを全部入れ替える）
  // 音声の情報は、この端末に音声本体があるものだけ残す。1トランザクションで行う。
  function importEntries(entries, mode) {
    return write(['entries', 'audio'], async (s) => {
      const blobIds = new Set(await reqP(s.audio.getAllKeys()));
      const current = new Map();
      if (mode === 'replace') s.entries.clear();
      else for (const e of await reqP(s.entries.getAll())) current.set(e.date, e);
      let changed = 0;
      for (const e of entries) {
        const cur = current.get(e.date);
        if (!cur || compare(e, cur) > 0) {
          s.entries.put({ ...e, audio: e.audio.filter((c) => blobIds.has(c.id)) });
          changed++;
        }
      }
      return changed;
    });
  }

  async function exportJSON() {
    return JSON.stringify({ app: 'diary', schemaVersion: DB_VERSION, exportedAt: nowISO(), entries: await allEntries() }, null, 2);
  }

  // beforeClose: 閉じる前に呼ぶ保存処理 / onBlocked: 別タブ待ちのとき呼ぶ（どちらも画面側が設定する）
  const api = {
    MOODS, init, loadEntry, updateEntry, addRecording, setTranscript, removeRecording, getAudio, deleteEntry,
    listEntries, allEntries, parseBackup, importEntries, exportJSON, compare, beforeClose: null, onBlocked: null,
  };
  return api;
})();

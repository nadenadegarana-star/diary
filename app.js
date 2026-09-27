// 画面の処理。データの読み書きは store.js の Store だけを通す。

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
// 日記の日付は端末のローカル日付で決める（UTC基準にすると夜に日付がずれる）
const toKey = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const localToday = () => { const n = new Date(); return toKey(n.getFullYear(), n.getMonth(), n.getDate()); };
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

// ---- 状態 ----
let todayKey = localToday();
let viewY = Number(todayKey.slice(0, 4));
let viewM = Number(todayKey.slice(5, 7)) - 1;
let selected = todayKey;
const written = new Set(); // 本文がある日付

// ---- カレンダー ----
function renderCalendar() {
  $('month-label').textContent = `${viewY}年 ${viewM + 1}月`;
  const grid = $('grid');
  grid.innerHTML = '';
  const firstDow = new Date(viewY, viewM, 1).getDay();
  const days = new Date(viewY, viewM + 1, 0).getDate();
  for (let i = 0; i < firstDow; i++) {
    grid.appendChild(Object.assign(document.createElement('span'), { className: 'day empty' }));
  }
  for (let d = 1; d <= days; d++) {
    const key = toKey(viewY, viewM, d);
    const b = document.createElement('button');
    b.className = 'day';
    b.textContent = d;
    b.dataset.date = key;
    const dow = (firstDow + d - 1) % 7;
    if (dow === 0) b.classList.add('sun');
    if (dow === 6) b.classList.add('sat');
    if (key === todayKey) b.classList.add('today');
    if (key === selected) b.classList.add('selected');
    if (written.has(key)) b.classList.add('has-entry');
    b.onclick = () => openDate(key, true);
    grid.appendChild(b);
  }
}

function moveMonth(delta) {
  const d = new Date(viewY, viewM + delta, 1);
  viewY = d.getFullYear();
  viewM = d.getMonth();
  renderCalendar();
}

// ---- 保存 ----
// 保存は必ず1つずつ順番に行う（前の保存が終わる前に次が走って古い本文で上書きするのを防ぐ）
// 入力ごとに番号(seq)を振り、失敗時に戻すのは「最後に予約した本文」だけにする。
let saveTimer = null;
let pending = null; // まだ保存を予約していない { date, text, seq }
let editSeq = 0;
let lastQueuedSeq = 0;
let inFlight = 0; // 保存処理中の件数
let saveChain = Promise.resolve(true);

function setStatus(s) { $('status').textContent = s; }
function setEditable(on) { $('text').readOnly = !on; }

// 未保存分を保存する。すべて保存できたら true、失敗したら false を返す（例外は投げない）。
function save() {
  clearTimeout(saveTimer);
  if (!pending) return saveChain;
  const { date, text, seq } = pending;
  pending = null;
  lastQueuedSeq = seq;
  inFlight++;
  setStatus('保存中…');
  saveChain = saveChain
    .then(() => Store.saveEntry(date, text))
    .then((entry) => {
      if (entry) written.add(date); else written.delete(date);
      const cell = document.querySelector(`.day[data-date="${date}"]`);
      if (cell) cell.classList.toggle('has-entry', written.has(date));
      if (!pending && seq === lastQueuedSeq) setStatus('保存済み');
      return true;
    })
    .catch((err) => {
      // 後から新しい本文が予約されていなければ、この本文を戻して次の機会に再保存する
      if (!pending && seq === lastQueuedSeq) pending = { date, text, seq };
      setStatus('⚠ 保存できません');
      console.error(err);
      return false;
    })
    .finally(() => { inFlight--; });
  return saveChain;
}

$('text').addEventListener('input', () => {
  pending = { date: selected, text: $('text').value, seq: ++editSeq };
  setStatus('…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 600);
});
// タブを閉じる・アプリを切り替える前に保存
document.addEventListener('visibilitychange', () => {
  if (document.hidden) save();
  else if (localToday() !== todayKey) { todayKey = localToday(); renderCalendar(); } // 日付が変わっていたら更新
});
addEventListener('pagehide', save);
addEventListener('beforeunload', (e) => {
  if (pending || inFlight) { save(); e.preventDefault(); } // 保存が間に合わない可能性があるときだけ確認
});

// ---- 日記を開く ----
// 切り替え中は入力を止める（前の日の本文を新しい日付に書いてしまうのを防ぐ）。
// 連打された場合は最後の要求だけが画面を更新する。
let openSeq = 0;
async function openDate(key, fromTap) {
  const my = ++openSeq;
  setEditable(false);
  try {
    if (!(await save())) return; // 保存に失敗したら切り替えない（本文を画面に残す）
    const entry = await Store.loadEntry(key);
    if (my !== openSeq) return;
    selected = key;
    const [y, m, d] = key.split('-').map(Number);
    $('date-label').textContent = `${y}年${m}月${d}日（${WEEK[new Date(y, m - 1, d).getDay()]}）`;
    $('text').value = entry ? entry.text : '';
    setStatus(entry ? '保存済み' : '');
  } finally {
    if (my === openSeq) setEditable(true);
  }
  renderCalendar();
  if (fromTap && !document.body.classList.contains('editing')) {
    document.body.classList.add('editing');
    history.pushState({ editing: true }, ''); // スマホの戻る操作でカレンダーへ戻す
  }
  if (fromTap && matchMedia('(min-width: 761px)').matches) $('text').focus();
}

// ---- バックアップ ----
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function exportBackup() {
  if (!(await save())) { alert('未保存の本文があるため、バックアップを中止しました。'); return; }
  download(`diary-backup-${localToday()}.json`, await Store.exportJSON());
}

// 読み込み中は編集を止める（取り込んだ内容を後から古い入力で上書きしないため）
async function importBackup(file) {
  setEditable(false);
  try { await doImport(file); } catch (err) { alert('読み込みに失敗しました。データは変更されていません。'); console.error(err); }
  finally { setEditable(true); }
}

async function doImport(file) {
  if (!(await save())) { alert('未保存の本文があるため、読み込みを中止しました。'); return; }
  const r = Store.parseBackup(await file.text());
  if (r.error) { alert(r.error); return; }
  const dlg = $('import-dialog');
  $('import-summary').textContent =
    `日記 ${r.live}件` +
    (r.entries.length > r.live ? `（削除記録 ${r.entries.length - r.live}件）` : '') +
    (r.invalid ? `／不正なデータ ${r.invalid}件は読み飛ばします` : '');
  dlg.returnValue = '';
  dlg.showModal();
  const mode = await new Promise((res) => dlg.addEventListener('close', () => res(dlg.returnValue), { once: true }));
  if (mode !== 'merge' && mode !== 'replace') return;
  // 置き換え前に今のデータを自動でバックアップしておく
  if (mode === 'replace') download(`diary-before-replace-${localToday()}.json`, await Store.exportJSON());
  const changed = await Store.importEntries(r.entries, mode);
  written.clear();
  for (const d of await Store.listDates()) written.add(d);
  alert(`${changed}件を反映しました。`);
  await openDate(selected, false);
}

// ---- 起動 ----
$('prev').onclick = () => moveMonth(-1);
$('next').onclick = () => moveMonth(1);
$('today').onclick = () => {
  todayKey = localToday();
  viewY = Number(todayKey.slice(0, 4));
  viewM = Number(todayKey.slice(5, 7)) - 1;
  openDate(todayKey, true);
};
$('back').onclick = () => history.back();
addEventListener('popstate', () => { save(); document.body.classList.remove('editing'); });
$('export').onclick = exportBackup;
$('import').onchange = (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; };

(async () => {
  renderCalendar();
  setEditable(false); // 保存領域を開くまでは書けないようにする
  Store.beforeClose = save; // 別タブで新しい版が開かれたとき、閉じる前に保存する
  Store.onBlocked = () => setStatus('別のタブで古い版が開いています。閉じると続行します…');
  try {
    await Store.init();
    for (const d of await Store.listDates()) written.add(d);
    await openDate(todayKey, false);
  } catch (err) {
    setStatus('⚠ 保存領域を開けません: ' + (err.message || err));
    $('text').disabled = true;
    return;
  }
  // ブラウザに勝手にデータを消されにくくする
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
})();

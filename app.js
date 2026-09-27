// 画面の処理。データの読み書きは store.js の Store だけを通す。

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
// 日記の日付は端末のローカル日付で決める（UTC基準にすると夜に日付がずれる）
const toKey = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const localToday = () => { const n = new Date(); return toKey(n.getFullYear(), n.getMonth(), n.getDate()); };
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const MOOD_LABEL = { happy: '嬉しい', calm: '穏やか', normal: 'ふつう', tired: '疲れた', moody: 'モヤモヤ', down: '落ち込み' };
const parts = (key) => key.split('-').map(Number);
const dow = (key) => { const [y, m, d] = parts(key); return WEEK[new Date(y, m - 1, d).getDay()]; };
const fmtDot = (key) => { const [y, m, d] = parts(key); return `${y}.${pad(m)}.${pad(d)}（${dow(key)}）`; };
const fmtJa = (key) => { const [, m, d] = parts(key); return `${m}月${d}日（${dow(key)}）`; };
const fmtDur = (s) => `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`;
const fmtTime = (iso) => { const t = new Date(iso); return `${pad(t.getHours())}:${pad(t.getMinutes())}`; };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// ---- 状態 ----
let todayKey = localToday();
const entries = new Map(); // date → entry（削除されていないもの）
let tab = 'home';
let entryDate = null; // 詳細画面で開いている日付
let calY = Number(todayKey.slice(0, 4));
let calM = Number(todayKey.slice(5, 7)) - 1;
let calSel = todayKey;

function setStatus(s) { $('status').textContent = s; }
function setEditable(on) { $('text').readOnly = !on; }

// ---- 保存（必ず1つずつ順番に行う） ----
let chain = Promise.resolve(true);
let inFlight = 0;
// task を順番待ちに入れる。成功したら true、失敗したら false（例外は投げない）
function enqueue(task) {
  inFlight++;
  chain = chain
    .then(task)
    .then(() => true, (err) => { console.error(err); setStatus('⚠ 保存できません'); return false; })
    .finally(() => { inFlight--; });
  return chain;
}

function applyEntry(date, e) {
  if (e) entries.set(date, e); else entries.delete(date);
}

// 本文の入力は600ms止まってから保存。入力ごとに番号(seq)を振り、失敗時に戻すのは最後に予約した本文だけ。
let textTimer = null;
let pendingText = null; // { date, text, seq }
let editSeq = 0;
let lastQueuedSeq = 0;

function flushText() {
  clearTimeout(textTimer);
  if (!pendingText) return chain;
  const p = pendingText;
  pendingText = null;
  lastQueuedSeq = p.seq;
  setStatus('保存中…');
  return enqueue(async () => {
    try {
      applyEntry(p.date, await Store.updateEntry(p.date, { text: p.text }));
      if (!pendingText && p.seq === lastQueuedSeq) setStatus('保存済み');
    } catch (err) {
      if (!pendingText && p.seq === lastQueuedSeq) pendingText = p; // 次の機会に再保存
      throw err;
    }
  });
}

$('text').addEventListener('input', () => {
  pendingText = { date: entryDate, text: $('text').value, seq: ++editSeq };
  setStatus('…');
  clearTimeout(textTimer);
  textTimer = setTimeout(flushText, 600);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) flushText();
  else if (localToday() !== todayKey) { todayKey = localToday(); render(); } // 日付が変わっていたら更新
});
addEventListener('pagehide', flushText);
addEventListener('beforeunload', (e) => {
  if (pendingText || inFlight) { flushText(); e.preventDefault(); } // 保存が間に合わない可能性があるときだけ確認
});

// ---- 画面の切り替え ----
function showView(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `v-${id}`));
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  scrollTo(0, 0);
}

// 画面を移る前に本文を保存する。保存中は入力を止め、失敗したら false（移動しない）。
async function leaveText() {
  if (!pendingText && !inFlight) return true;
  setEditable(false);
  try { return await flushText(); } finally { setEditable(true); }
}

// 文字起こしの結果を本文に追記する。開いている日記なら、入力中の本文を先に保存してから反映する。
async function applyTranscript(date, clipId, text) {
  const editing = entryDate === date;
  if (editing) setEditable(false);
  try {
    await flushText();
    await enqueue(async () => applyEntry(date, await Store.setTranscript(date, clipId, text, true)));
    if (entryDate === date) renderEntry(true); else render();
  } finally {
    if (editing) setEditable(true);
  }
}

async function showTab(name) {
  if (!(await leaveText())) return;
  tab = name;
  entryDate = null;
  showView(name);
  render();
}

function render() {
  if (entryDate) return renderEntry(false);
  ({ home: renderHome, timeline: renderTimeline, calendar: renderCalendar, mypage: renderMypage })[tab]();
}

document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });

// ---- 部品 ----
function moodChips(container, date) {
  container.innerHTML = '';
  const cur = entries.get(date)?.mood;
  for (const key of Store.MOODS) {
    const b = el('button', 'mood' + (cur === key ? ' on' : ''));
    b.append(el('span', `dot ${key}`), MOOD_LABEL[key]);
    b.onclick = () => setMood(date, key);
    container.append(b);
  }
}

async function setMood(date, key) {
  await flushText();
  await enqueue(async () => {
    const next = entries.get(date)?.mood === key ? null : key; // 同じ気分をもう一度押したら解除
    applyEntry(date, await Store.updateEntry(date, { mood: next }));
  });
  render();
}

function waveBars(peaks, n = 48) {
  const w = el('div', 'mini-wave');
  const src = peaks && peaks.length ? peaks : [];
  for (let i = 0; i < n; i++) {
    const v = src.length ? src[Math.floor((i / n) * src.length)] : 0.1;
    const bar = el('i');
    bar.style.height = `${Math.max(8, Math.round(v * 100))}%`;
    w.append(bar);
  }
  return w;
}

const PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
let playing = null; // 再生中の Audio（同時に1つだけ）

// 再生ボタン＋波形。getBlob は再生するときに初めて呼ばれる。
function clipPlayer({ getBlob, peaks, duration, meta, actions }) {
  const row = el('div', 'clip');
  const btn = el('button', 'play');
  btn.innerHTML = PLAY;
  btn.setAttribute('aria-label', '再生');
  const mid = el('div');
  const wave = waveBars(peaks);
  mid.append(wave);
  if (meta) mid.append(el('div', 'clip-meta', meta));
  row.append(btn, mid);
  if (actions) row.append(actions);

  let audio = null;
  let url = null;
  const bars = [...wave.children];
  const paint = () => {
    const f = audio ? Math.min(1, audio.currentTime / (duration || audio.duration || 1)) : 0;
    bars.forEach((b, i) => b.classList.toggle('played', i / bars.length < f));
  };
  async function ensure() {
    if (audio) return audio;
    const blob = await getBlob();
    if (!blob) { alert('音声データが見つかりません。'); return null; }
    url = URL.createObjectURL(blob);
    audio = new Audio(url);
    audio.ontimeupdate = paint;
    audio.onplay = () => { btn.innerHTML = PAUSE; };
    audio.onpause = audio.onended = () => { btn.innerHTML = PLAY; paint(); };
    return audio;
  }
  btn.onclick = async () => {
    const a = await ensure();
    if (!a) return;
    if (!a.paused) { a.pause(); return; }
    if (playing && playing !== a) playing.pause();
    playing = a;
    a.play();
  };
  wave.onclick = async (e) => {
    const a = await ensure();
    if (!a) return;
    const r = wave.getBoundingClientRect();
    a.currentTime = ((e.clientX - r.left) / r.width) * (duration || a.duration || 0);
    paint();
  };
  row.release = () => { if (audio) audio.pause(); if (url) URL.revokeObjectURL(url); };
  return row;
}

// ---- ホーム ----
function renderHome() {
  $('home-date').textContent = fmtDot(todayKey);
  const e = entries.get(todayKey);
  const card = $('home-entry');
  card.innerHTML = '';
  const icon = el('span', `dot ${e?.mood || 'none'}`);
  const p = el('p', null, e?.text.trim() ? e.text.trim() : e?.audio.length ? `録音 ${e.audio.length}件` : '文字で書く');
  card.append(icon, p, el('span', 'chev', '›'));
  card.onclick = () => openEntry(todayKey);
  moodChips($('home-moods'), todayKey);
}

$('mic').onclick = () => startRecording(todayKey);

// ---- タイムライン ----
function renderTimeline() {
  const list = $('tl-list');
  list.innerHTML = '';
  const sorted = [...entries.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!sorted.length) { list.append(el('p', 'empty-msg', 'まだ日記がありません。ホームから録音してみましょう。')); return; }
  for (const e of sorted) {
    const item = el('button', 'card tl-item');
    const body = el('div', 'body');
    const head = el('div', 'tl-date');
    head.append(el('span', null, fmtJa(e.date) + (e.mood ? `　${MOOD_LABEL[e.mood]}` : '')));
    const total = e.audio.reduce((a, c) => a + c.duration, 0);
    if (total) head.append(el('span', null, fmtDur(total)));
    body.append(head);
    if (e.audio.length) body.append(waveBars(e.audio[0].peaks, 60));
    if (e.text.trim()) body.append(el('p', 'tl-text', e.text.trim()));
    item.append(el('span', `dot ${e.mood || 'none'}`), body);
    item.onclick = () => openEntry(e.date);
    list.append(item);
  }
}
$('tl-rec').onclick = () => startRecording(todayKey);

// ---- カレンダー ----
function renderCalendar() {
  $('month-label').textContent = `${calY}年${calM + 1}月`;
  const grid = $('grid');
  grid.innerHTML = '';
  const offset = (new Date(calY, calM, 1).getDay() + 6) % 7; // 月曜始まり
  const days = new Date(calY, calM + 1, 0).getDate();
  for (let i = 0; i < offset; i++) grid.append(el('span', 'day empty'));
  const counts = {};
  for (let d = 1; d <= days; d++) {
    const key = toKey(calY, calM, d);
    const e = entries.get(key);
    const b = el('button', 'day');
    const wd = (offset + d - 1) % 7;
    if (wd === 5) b.classList.add('sat');
    if (wd === 6) b.classList.add('sun');
    if (key === todayKey) b.classList.add('today');
    if (key === calSel) b.classList.add('selected');
    b.append(el('span', null, d), el('span', `dot ${e ? e.mood || 'none' : 'blank'}`));
    if (e?.mood) counts[e.mood] = (counts[e.mood] || 0) + 1;
    b.onclick = () => { calSel = key; renderCalendar(); };
    grid.append(b);
  }
  renderCalDetail();
  renderDonut(counts);
}

function renderCalDetail() {
  const box = $('cal-detail');
  box.innerHTML = '';
  const e = entries.get(calSel);
  const card = el('button', 'card entry-card');
  card.append(el('span', `dot ${e ? e.mood || 'none' : 'blank'}`));
  const text = e ? (e.text.trim() || (e.audio.length ? `録音 ${e.audio.length}件` : '')) : 'この日の日記はありません。タップして書く';
  const p = el('p');
  p.append(el('span', 'muted', `${fmtJa(calSel)}　`), text);
  card.append(p, el('span', 'chev', '›'));
  card.onclick = () => openEntry(calSel);
  box.append(card);
}

function renderDonut(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const svg = $('donut');
  const legend = $('mood-legend');
  legend.innerHTML = '';
  let html = '<circle cx="21" cy="21" r="15.915" stroke="var(--line)" stroke-width="6"/>';
  let at = 0;
  for (const key of Store.MOODS) {
    const n = counts[key] || 0;
    if (!n) continue;
    const pct = (n / total) * 100;
    html += `<circle cx="21" cy="21" r="15.915" stroke="var(--m-${key})" stroke-width="6" stroke-dasharray="${pct} ${100 - pct}" stroke-dashoffset="${-at}"/>`;
    at += pct;
    const li = el('li');
    li.append(el('span', `dot ${key}`), MOOD_LABEL[key], el('b', null, `${n}日`));
    legend.append(li);
  }
  svg.innerHTML = html;
  if (!total) legend.append(el('li', 'muted', 'まだ気分の記録がありません'));
}

$('prev').onclick = () => { const d = new Date(calY, calM - 1, 1); calY = d.getFullYear(); calM = d.getMonth(); renderCalendar(); };
$('next').onclick = () => { const d = new Date(calY, calM + 1, 1); calY = d.getFullYear(); calM = d.getMonth(); renderCalendar(); };

// ---- マイページ ----
async function renderMypage() {
  const sel = $('model-select');
  if (!sel.options.length) {
    for (const [k, m] of Object.entries(Transcriber.MODELS)) sel.append(new Option(m.label, k));
    sel.onchange = () => { Transcriber.setModel(sel.value); renderMypage(); };
  }
  sel.value = Transcriber.getModel();
  $('count').textContent = `${entries.size}日分`;
  $('model-status').textContent = (await Transcriber.isDownloaded()) ? 'ダウンロード済み（オフラインで使えます）' : '未ダウンロード（初回の文字起こし時に取得）';
  try {
    const est = await navigator.storage.estimate();
    $('usage').textContent = `${(est.usage / 1024 / 1024).toFixed(1)} MB`;
  } catch { $('usage').textContent = '不明'; }
}

$('model-download').onclick = async () => {
  const st = $('model-status');
  st.textContent = 'ダウンロード中…';
  try {
    await Transcriber.download((p) => { st.textContent = `ダウンロード中… ${Math.round(p * 100)}%`; });
  } catch (err) {
    alert('ダウンロードできませんでした。ネット接続を確認してください。');
    console.error(err);
  }
  renderMypage();
};
$('model-remove').onclick = async () => {
  if (!confirm('文字起こしモデルを端末から削除しますか？（日記は消えません）')) return;
  await Transcriber.removeModel();
  renderMypage();
};

// ---- 日記の詳細 ----
async function openEntry(date) {
  if (!(await leaveText())) return;
  entryDate = date;
  showView('entry');
  renderEntry(true);
  history.pushState({ entry: date }, ''); // スマホの戻る操作で元の画面へ
}

let clipRows = [];
function renderEntry(fillText) {
  const date = entryDate;
  const e = entries.get(date);
  $('entry-date').textContent = fmtDot(date);
  moodChips($('entry-moods'), date);
  clipRows.forEach((r) => r.release());
  const box = $('entry-clips');
  box.innerHTML = '';
  clipRows = (e?.audio || []).map((c) => {
    const actions = el('div', 'clip-actions');
    if (!c.transcript) {
      const t = el('button', 'text-btn', '文字起こし');
      t.onclick = () => transcribeClip(date, c, t);
      actions.append(t);
    }
    const del = el('button', 'text-btn', '削除');
    del.onclick = () => removeClip(date, c);
    actions.append(del);
    const row = clipPlayer({ getBlob: () => Store.getAudio(c.id), peaks: c.peaks, duration: c.duration, meta: `${fmtTime(c.createdAt)} ・ ${fmtDur(c.duration)}`, actions });
    box.append(row);
    return row;
  });
  // 入力中の本文は上書きしない
  if (fillText || (!pendingText && document.activeElement !== $('text'))) {
    $('text').value = e ? e.text : '';
    setStatus(fillText && e ? '保存済み' : $('status').textContent);
  }
}

addEventListener('popstate', async () => {
  if (!entryDate) return;
  if (!(await leaveText())) { history.pushState({ entry: entryDate }, ''); return; } // 保存できなければ画面に残る
  clipRows.forEach((r) => r.release());
  entryDate = null;
  showView(tab);
  render();
});
$('entry-back').onclick = () => history.back();

$('entry-delete').onclick = async () => {
  const date = entryDate;
  if (!confirm(`${fmtJa(date)}の日記（本文・気分・録音）を削除しますか？`)) return;
  clearTimeout(textTimer);
  pendingText = null;
  const ok = await enqueue(async () => { await Store.deleteEntry(date); applyEntry(date, null); });
  if (ok) history.back();
};

$('entry-rec').onclick = () => startRecording(entryDate);

async function removeClip(date, clip) {
  if (!confirm('この録音を削除しますか？（文字起こし済みの本文は残ります）')) return;
  await flushText();
  await enqueue(async () => applyEntry(date, await Store.removeRecording(date, clip.id)));
  render();
}

// 文字起こしモデルが未取得なら確認してから進める
async function ensureModel() {
  if (await Transcriber.isDownloaded()) return true;
  const label = Transcriber.MODELS[Transcriber.getModel()].label;
  return confirm(`文字起こし用のモデル（${label}）を初回だけダウンロードします。Wi-Fiでの利用がおすすめです。続けますか？`);
}

async function transcribeClip(date, clip, btn) {
  if (!(await ensureModel())) return;
  btn.disabled = true;
  btn.textContent = '文字起こし中…';
  try {
    const blob = await Store.getAudio(clip.id);
    const text = await Transcriber.transcribe(blob, (p) => { btn.textContent = `準備中 ${Math.round(p * 100)}%`; });
    await applyTranscript(date, clip.id, text);
  } catch (err) {
    console.error(err);
    alert('文字起こしできませんでした。' + (navigator.onLine ? '' : '（初回はネット接続が必要です）'));
    btn.disabled = false;
    btn.textContent = '文字起こし';
  }
}

// ---- 録音 ----
let recDate = null;
let levels = [];
let recRaf = 0;
let wakeLock = null;

async function startRecording(date) {
  if (!Recorder.supported()) { alert('この端末・ブラウザでは録音できません。'); return; }
  if (Recorder.isBusy() || review) return; // 録音中・確認画面の表示中は新しく始めない
  await flushText();
  recDate = date;
  levels = [];
  try {
    await Recorder.start(
      (l) => { levels.push(l); if (levels.length > 90) levels.shift(); },
      () => { alert('マイクが使えなくなったため録音を止めました。ここまでの録音は保存できます。'); stopRecording(); },
    );
  } catch (err) {
    console.error(err);
    alert('マイクを使えませんでした。ブラウザの設定でマイクを許可してください。');
    return;
  }
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {} // 録音中は画面を消さない
  $('rec').hidden = false;
  drawRec();
}

function drawRec() {
  const c = $('rec-wave');
  const g = c.getContext('2d');
  const n = 90;
  const w = c.width / n;
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = '#9fb8d3';
  for (let i = 0; i < n; i++) {
    const v = levels[levels.length - n + i] ?? 0;
    const h = Math.max(4, v * c.height * 0.9);
    g.fillRect(i * w + w * 0.3, (c.height - h) / 2, w * 0.4, h);
  }
  $('rec-time').textContent = fmtDur(Recorder.elapsed());
  recRaf = requestAnimationFrame(drawRec);
}

function endRecUI() {
  cancelAnimationFrame(recRaf);
  $('rec').hidden = true;
  try { wakeLock && wakeLock.release(); } catch {}
  wakeLock = null;
}

async function stopRecording() {
  const r = await Recorder.stop();
  if (!r) return; // すでに止めている（連打など）
  endRecUI();
  openReview({ ...r, date: recDate });
}
$('rec-stop').onclick = stopRecording;
$('rec-cancel').onclick = () => {
  if (Recorder.elapsed() > 5 && !confirm('録音を破棄しますか？')) return;
  Recorder.cancel();
  endRecUI();
};

// ---- 録音後の確認 ----
// clipId は保存前に決めておき、保存後に届いた文字起こしをその録音に結びつける。
// saved は保存ボタンを押した時点で true（保存と追記は同じ順番待ちに入るので、必ず保存が先に行われる）。
let review = null; // { date, blob, duration, peaks, clipId, transcript, running, saved }
let reviewPlayer = null;

function openReview(r) {
  review = { ...r, clipId: crypto.randomUUID(), transcript: null, running: false, saved: false };
  $('review-dur').textContent = fmtDur(r.duration);
  $('review-text').value = '';
  const box = $('review-player');
  box.innerHTML = '';
  reviewPlayer = clipPlayer({ getBlob: async () => r.blob, peaks: r.peaks, duration: r.duration });
  box.append(reviewPlayer);
  $('review').hidden = false;
  prepareTranscription(review);
}

function trStatus(text, buttonLabel, onClick) {
  const s = $('tr-status');
  s.innerHTML = '';
  s.append(text);
  if (buttonLabel) {
    const b = el('button', 'text-btn', buttonLabel);
    b.onclick = onClick;
    s.append(b);
  }
}

async function prepareTranscription(rv) {
  if (await Transcriber.isDownloaded()) return runTranscription(rv);
  trStatus('', '文字起こしする（初回のみモデルをダウンロード）', () => runTranscription(rv));
}

async function runTranscription(rv) {
  rv.running = true;
  trStatus('文字起こし中…（しばらくかかります）');
  try {
    const text = await Transcriber.transcribe(rv.blob, (p) => { if (review === rv) trStatus(`モデルを準備中… ${Math.round(p * 100)}%`); });
    rv.transcript = text;
    if (rv.saved) {
      // 待たずに保存した場合は、終わった時点で日記に追記する（録音が消されていれば何もしない）
      await applyTranscript(rv.date, rv.clipId, text);
      return;
    }
    if (review !== rv) return;
    const ta = $('review-text');
    ta.value = ta.value.trim() ? ta.value.replace(/\s+$/, '') + '\n' + text : text;
    trStatus(text ? '完了（直してから保存できます）' : '声を聞き取れませんでした');
  } catch (err) {
    console.error(err);
    if (review === rv) trStatus('できませんでした', 'もう一度', () => runTranscription(rv));
  } finally {
    rv.running = false;
  }
}

$('review-save').onclick = async () => {
  const rv = review;
  if (!rv) return;
  if (rv.saved) return; // 二重保存を防ぐ
  if (rv.running && !confirm('文字起こし中です。待たずに保存しますか？（終わりしだい日記に追記されます）')) return;
  $('review-save').disabled = true;
  const text = $('review-text').value;
  const transcript = rv.transcript; // この時点で終わっていれば原文として一緒に保存（本文は画面の内容を使う）
  rv.saved = true;
  if (entryDate === rv.date) { setEditable(false); await flushText(); }
  const ok = await enqueue(async () => {
    applyEntry(rv.date, await Store.addRecording(rv.date, rv.blob, { id: rv.clipId, duration: rv.duration, peaks: rv.peaks, transcript }, text));
  });
  $('review-save').disabled = false;
  if (entryDate === rv.date) { renderEntry(true); setEditable(true); }
  if (!ok) {
    rv.saved = false;
    // 保存を待つ間に届いた文字起こしは画面に戻す
    if (rv.transcript && transcript == null) {
      const ta = $('review-text');
      ta.value = ta.value.trim() ? ta.value.replace(/\s+$/, '') + '\n' + rv.transcript : rv.transcript;
    }
    alert('保存できませんでした。もう一度お試しください。');
    return;
  }
  closeReview();
  render();
};

$('review-close').onclick = () => {
  if (!confirm('この録音を保存せずに閉じますか？')) return;
  closeReview();
};

function closeReview() {
  if (reviewPlayer) reviewPlayer.release();
  reviewPlayer = null;
  review = null;
  $('review').hidden = true;
}

// ---- バックアップ ----
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('export').onclick = async () => {
  if (!(await flushText())) { alert('未保存の本文があるため、バックアップを中止しました。'); return; }
  download(`diary-backup-${localToday()}.json`, await Store.exportJSON());
};

$('import').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  setEditable(false); // 読み込み中は編集を止める
  try { await doImport(file); } catch (err) { alert('読み込みに失敗しました。データは変更されていません。'); console.error(err); }
  finally { setEditable(true); }
};

async function doImport(file) {
  if (!(await flushText())) { alert('未保存の本文があるため、読み込みを中止しました。'); return; }
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
  await reloadEntries();
  alert(`${changed}件を反映しました。`);
  render();
}

async function reloadEntries() {
  entries.clear();
  for (const e of await Store.listEntries()) entries.set(e.date, e);
}

// ---- 起動 ----
(async () => {
  setEditable(false); // 保存領域を開くまでは書けないようにする
  Store.beforeClose = flushText; // 別タブで新しい版が開かれたとき、閉じる前に保存する
  Store.onBlocked = () => { $('home-date').textContent = '別のタブで古い版が開いています。閉じると続行します…'; };
  try {
    await Store.init();
    await reloadEntries();
  } catch (err) {
    $('home-date').textContent = '⚠ 保存領域を開けません: ' + (err.message || err);
    return;
  }
  setEditable(true);
  showTab('home');
  // ブラウザに勝手にデータを消されにくくする
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
})();

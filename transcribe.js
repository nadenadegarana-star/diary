// 文字起こしの窓口。ワーカー(whisper-worker.js)に音声を渡して結果を受け取る。
const Transcriber = (() => {
  const MODELS = {
    base: { id: 'onnx-community/whisper-base', label: '標準（約80MB・速い）' },
    small: { id: 'onnx-community/whisper-small', label: '高精度（約250MB・遅い）' },
  };
  let worker = null;
  let seq = 0;
  const jobs = new Map();

  function getWorker() {
    if (!worker) {
      worker = new Worker('whisper-worker.js', { type: 'module' });
      worker.onmessage = ({ data }) => {
        const job = jobs.get(data.id);
        if (!job) return;
        if (data.type === 'progress') { job.onProgress && job.onProgress(data); return; }
        jobs.delete(data.id);
        if (data.type === 'done') job.resolve(data.text ?? '');
        else job.reject(new Error(data.message));
      };
      worker.onerror = (e) => {
        for (const j of jobs.values()) j.reject(new Error(e.message || '文字起こしの準備に失敗しました'));
        jobs.clear();
        worker = null;
      };
    }
    return worker;
  }

  function send(msg, onProgress, transfer) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      jobs.set(id, { resolve, reject, onProgress });
      getWorker().postMessage({ ...msg, id }, transfer || []);
    });
  }

  let modelKey = 'base';
  try { modelKey = localStorage.getItem('whisperModel') || 'base'; } catch {}
  const getModel = () => (MODELS[modelKey] ? modelKey : 'base');
  function setModel(key) { modelKey = key; try { localStorage.setItem('whisperModel', key); } catch {} }

  // オフラインで文字起こしできる状態か。
  // 一度最後まで読み込めたモデルを記録し、さらにモデル本体（encoder/decoder）が
  // Cache Storage に残っていることを確かめる（transformers.js は 'transformers-cache' に保存する）。
  const readyKey = (key) => `whisperReady:${MODELS[key].id}`;
  function markReady(key, on) { try { on ? localStorage.setItem(readyKey(key), '1') : localStorage.removeItem(readyKey(key)); } catch {} }
  async function isDownloaded(key = getModel()) {
    try {
      if (!localStorage.getItem(readyKey(key))) return false;
      const urls = (await (await caches.open('transformers-cache')).keys()).map((r) => r.url).filter((u) => u.includes(MODELS[key].id));
      return urls.some((u) => u.includes('encoder')) && urls.some((u) => u.includes('decoder'));
    } catch { return false; }
  }

  async function removeModel(key = getModel()) {
    markReady(key, false);
    const cache = await caches.open('transformers-cache');
    for (const r of await cache.keys()) if (r.url.includes(MODELS[key].id)) await cache.delete(r);
  }

  // onProgress(0〜1) はダウンロード中だけ呼ばれる
  function progressTracker(onProgress) {
    const files = {};
    return (p) => {
      files[p.file] = p;
      const all = Object.values(files);
      const total = all.reduce((a, f) => a + (f.total || 0), 0);
      const loaded = all.reduce((a, f) => a + (f.loaded || 0), 0);
      if (total && onProgress) onProgress(loaded / total);
    };
  }

  async function download(onProgress) {
    const key = getModel();
    await send({ type: 'load', model: MODELS[key].id }, progressTracker(onProgress));
    markReady(key, true);
  }

  // 録音(Blob)を16kHzモノラルに変換してから渡す
  async function transcribe(blob, onProgress) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx({ sampleRate: 16000 });
    let pcm;
    try {
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      pcm = decoded.getChannelData(0);
      if (decoded.numberOfChannels > 1) {
        const r = decoded.getChannelData(1);
        pcm = pcm.map((v, i) => (v + r[i]) / 2);
      } else {
        pcm = new Float32Array(pcm);
      }
    } finally {
      ctx.close();
    }
    const key = getModel();
    const text = await send({ type: 'run', model: MODELS[key].id, audio: pcm }, progressTracker(onProgress), [pcm.buffer]);
    markReady(key, true); // 最後まで動いた＝必要なファイルがそろっている
    return text;
  }

  return { MODELS, getModel, setModel, isDownloaded, removeModel, download, transcribe };
})();

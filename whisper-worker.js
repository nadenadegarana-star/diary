// 文字起こし用のワーカー（画面を固まらせないよう別スレッドで動かす）。
// Whisperを端末の中で動かす。音声は外部に送られない。モデルは初回だけダウンロードされ、ブラウザ内に保存される。
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';

env.allowLocalModels = false;
let asr = null;
let loadedModel = null;

async function load(model, id) {
  if (asr && loadedModel === model) return asr;
  if (asr) { try { await asr.dispose(); } catch {} } // 別のモデルに切り替えるときはメモリを解放
  asr = null;
  asr = await pipeline('automatic-speech-recognition', model, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (p) => {
      if (p.status === 'progress') self.postMessage({ id, type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
    },
  });
  loadedModel = model;
  return asr;
}

// 依頼は1件ずつ順番に処理する（モデルの二重読み込みや切り替えの競合を防ぐ）
let queue = Promise.resolve();
self.onmessage = ({ data }) => { queue = queue.then(() => handle(data)); };

async function handle(data) {
  const { id, type, model, audio } = data;
  try {
    const p = await load(model, id);
    if (type === 'load') { self.postMessage({ id, type: 'done' }); return; }
    const out = await p(audio, { language: 'japanese', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
    self.postMessage({ id, type: 'done', text: (out.text || '').trim() });
  } catch (e) {
    self.postMessage({ id, type: 'error', message: String((e && e.message) || e) });
  }
}

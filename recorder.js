// 録音。MediaRecorderで録りながら、音量を拾って波形表示用の値(peaks)も作る。
// 状態: idle → starting → recording → stopping → idle。開始・停止は1回ずつしか動かない。
const Recorder = (() => {
  let state = 'idle';
  let stream, rec, chunks, ctx, levelTimer, startAt, levels, duration;
  let finishWith = null; // 録音が止まったときに結果を渡す先（キャンセル時は null）
  let leftover = null; // 勝手に止まった録音の結果（stop() で回収する）
  let interrupted = null;

  function pickMime() {
    const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
    return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }

  // onLevel(0〜1): 約50msごと（リアルタイム波形用）
  // onInterrupted(): マイクが途中で使えなくなったとき（他のアプリに取られた等）。ここまでの録音は stop() で回収できる
  async function start(onLevel, onInterrupted) {
    if (state !== 'idle') throw new Error('録音中です');
    state = 'starting';
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mimeType = pickMime();
      rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined);
      chunks = [];
      levels = [];
      finishWith = null;
      leftover = null;
      interrupted = onInterrupted;
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = finish; // 止めた理由に関係なく、止まったら必ずここを通る
      rec.onerror = () => { if (state === 'recording') onInterrupted && onInterrupted(); };
      stream.getAudioTracks().forEach((t) => { t.onended = () => { if (state === 'recording') onInterrupted && onInterrupted(); }; });

      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      levelTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
        levels.push(level);
        onLevel && onLevel(level);
      }, 50);

      rec.start(1000);
      startAt = performance.now();
      state = 'recording';
    } catch (err) {
      cleanup();
      throw err;
    }
  }

  const elapsed = () => (startAt ? (performance.now() - startAt) / 1000 : 0);

  function cleanup() {
    clearInterval(levelTimer);
    if (stream) stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    if (ctx) ctx.close().catch(() => {});
    stream = ctx = rec = null;
    startAt = 0;
    state = 'idle';
  }

  function finish() {
    const elapsedAtStop = elapsed();
    const done = finishWith;
    const type = rec?.mimeType || chunks[0]?.type || '';
    const result = { blob: new Blob(chunks, { type }), duration, peaks: downsample(levels, 60) };
    const unexpected = !done && state === 'recording'; // 停止ボタンもキャンセルも押していないのに止まった
    finishWith = null;
    cleanup();
    if (done) done(result);
    else if (unexpected) { result.duration = elapsedAtStop; leftover = result; interrupted && interrupted(); }
  }

  // 録音を終えて { blob, duration, peaks } を返す。録音していなければ null。
  function stop() {
    if (leftover) { const r = leftover; leftover = null; return Promise.resolve(r); }
    if (state !== 'recording') return Promise.resolve(null);
    state = 'stopping';
    duration = elapsed();
    return new Promise((resolve) => {
      finishWith = resolve;
      if (rec.state === 'inactive') finish(); else rec.stop();
    });
  }

  function cancel() {
    leftover = null;
    if (state === 'idle') return;
    finishWith = null;
    state = 'stopping';
    if (rec && rec.state !== 'inactive') rec.stop(); // onstop → finish → cleanup（結果は捨てる）
    else cleanup();
  }

  function downsample(arr, n) {
    if (!arr.length) return [];
    const out = [];
    const step = arr.length / n;
    for (let i = 0; i < n; i++) {
      const part = arr.slice(Math.floor(i * step), Math.max(Math.floor(i * step) + 1, Math.floor((i + 1) * step)));
      out.push(Math.round(Math.max(...part) * 100) / 100);
    }
    return out;
  }

  return { start, stop, cancel, elapsed, isBusy: () => state !== 'idle', supported: () => !!(navigator.mediaDevices && window.MediaRecorder) };
})();

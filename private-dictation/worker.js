/* Voxoira private dictation worker.
   Runs Whisper locally with Transformers.js. Audio never leaves the device; only model files are downloaded
   (from jsDelivr and Hugging Face) and cached by the browser. */
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

let asr = null, modelId = '', device = '', english = false, busy = false;

const post = (m, t) => self.postMessage(m, t || []);

function opts(language) {
  // English-only models (*.en) throw if you pass language/task
  if (english) return {};
  const o = { task: 'transcribe' };
  if (language && language !== 'auto') o.language = language;
  return o;
}

async function init(msg) {
  const { model, prefer } = msg;
  modelId = model;
  english = /\.en$/.test(model);
  let lib;
  try {
    lib = await import(TRANSFORMERS_URL);
  } catch (e) {
    post({ type: 'error', fatal: true, message: 'Could not load the speech library (' + (e.message || e) + '). Check your connection.' });
    return;
  }
  lib.env.allowLocalModels = false;

  // Ordered attempts. GPU is far faster when it works; each attempt is verified with a real warm-up inference.
  const attempts = [];
  if (prefer !== 'cpu' && self.navigator && navigator.gpu) {
    attempts.push({ device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, label: 'GPU (WebGPU)' });
  }
  if (prefer !== 'gpu') {
    attempts.push({ device: 'wasm', dtype: 'q8', label: 'CPU (WebAssembly)' });
    attempts.push({ device: 'wasm', dtype: undefined, label: 'CPU (WebAssembly, default precision)' });
  } else if (!attempts.length) {
    post({ type: 'error', fatal: true, message: 'WebGPU is not available in this browser. Choose "Auto" or "CPU".' });
    return;
  }

  let lastErr = null;
  for (const a of attempts) {
    try {
      post({ type: 'status', message: 'Loading model on ' + a.label + '…' });
      const cfg = { device: a.device, progress_callback: p => post({ type: 'progress', p: { status: p.status, file: p.file, loaded: p.loaded, total: p.total } }) };
      if (a.dtype) cfg.dtype = a.dtype;
      asr = await lib.pipeline('automatic-speech-recognition', model, cfg);
      // warm-up: compiles GPU shaders and surfaces unsupported-op errors before the user starts speaking
      await asr(new Float32Array(16000), opts('english'));
      device = a.label;
      post({ type: 'ready', device, model });
      return;
    } catch (e) {
      lastErr = e;
      asr = null;
      post({ type: 'status', message: a.label + ' failed (' + String(e && e.message || e).slice(0, 120) + '). Trying the next option…' });
    }
  }
  post({ type: 'error', fatal: true, message: 'Could not start the speech model: ' + String(lastErr && lastErr.message || lastErr) });
}

async function transcribe(msg) {
  const { id, audio, final, language, rms, durationSec } = msg;
  if (!asr) { post({ type: 'result', id, final, text: '', error: 'model not ready' }); return; }
  const t0 = performance.now();
  try {
    const out = await asr(audio, opts(language));
    const text = Array.isArray(out) ? (out[0] && out[0].text) || '' : (out && out.text) || '';
    post({ type: 'result', id, final, text, ms: performance.now() - t0, audioSec: audio.length / 16000, rms, durationSec });
  } catch (e) {
    post({ type: 'result', id, final, text: '', error: String(e && e.message || e), ms: performance.now() - t0 });
  }
}

self.onmessage = e => {
  const m = e.data;
  if (m.type === 'init') init(m);
  else if (m.type === 'transcribe') transcribe(m);
};

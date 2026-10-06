/* Voxoira on-device speech engine.
   A drop-in stand-in for the browser's SpeechRecognition (webkitSpeechRecognition) that runs Whisper locally
   through /private-dictation/worker.js. It only needs getUserMedia, so it keeps working in installed apps (PWAs)
   where the browser's own speech service is unavailable. Audio never leaves the device; only the model files are
   downloaded once (jsDelivr + Hugging Face) and then cached by the browser.

   Exposes window.VoxWhisperRecognition (same events as SpeechRecognition: onstart, onresult, onerror, onend).
   Requires assets/dictation-core.js (window.VoxCore) to be loaded first. */
(function (global) {
  'use strict';

  var CORE = global.VoxCore;
  var AC = global.AudioContext || global.webkitAudioContext;
  var nav = global.navigator || {};
  if (!CORE || !AC || !global.Worker || !nav.mediaDevices || !nav.mediaDevices.getUserMedia) return; // unsupported: leave undefined

  var MODEL = 'onnx-community/whisper-base';        // multilingual, ~75 MB, cached after first download
  var WORKER_URL = '/private-dictation/worker.js';
  var IDLE_MS = 6000;      // keep the mic open this long between sessions so quick restarts don't re-prompt
  var ORPHAN_MS = 5000;    // a result that arrives between two sessions is still delivered if this fresh

  var LANG = {
    en: 'english', es: 'spanish', fr: 'french', de: 'german', it: 'italian', pt: 'portuguese', nl: 'dutch', ru: 'russian',
    zh: 'chinese', ja: 'japanese', ko: 'korean', ar: 'arabic', hi: 'hindi', bn: 'bengali', pa: 'punjabi', ta: 'tamil',
    te: 'telugu', mr: 'marathi', gu: 'gujarati', kn: 'kannada', ml: 'malayalam', ur: 'urdu', tr: 'turkish', pl: 'polish',
    uk: 'ukrainian', cs: 'czech', sk: 'slovak', sv: 'swedish', no: 'norwegian', nb: 'norwegian', nn: 'norwegian',
    da: 'danish', fi: 'finnish', el: 'greek', he: 'hebrew', th: 'thai', vi: 'vietnamese', id: 'indonesian', ms: 'malay',
    fil: 'tagalog', tl: 'tagalog', ro: 'romanian', hu: 'hungarian', bg: 'bulgarian', hr: 'croatian', sr: 'serbian',
    sl: 'slovenian', lt: 'lithuanian', lv: 'latvian', et: 'estonian', sw: 'swahili', af: 'afrikaans', am: 'amharic',
    is: 'icelandic', ca: 'catalan', eu: 'basque', gl: 'galician', fa: 'persian', km: 'khmer', lo: 'lao', my: 'burmese',
    ne: 'nepali', si: 'sinhala', az: 'azerbaijani', hy: 'armenian', ka: 'georgian', mn: 'mongolian', uz: 'uzbek', kk: 'kazakh'
  };
  function whisperLang(tag) {
    var p = String(tag || '').toLowerCase().split(/[-_]/)[0];
    return LANG[p] || 'auto';
  }

  var WORKLET = "class C extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(4096);this.n=0}" +
    "process(i){var x=i[0]&&i[0][0];if(!x)return true;for(var k=0;k<x.length;k++){this.b[this.n++]=x[k];" +
    "if(this.n===4096){this.port.postMessage(this.b.slice());this.n=0}}return true}}registerProcessor('vox-cap',C);";

  /* ---------- small status pill (model download / ready) ---------- */
  var pill = null, pillTimer = null;
  function say(msg, hideAfterMs) {
    try {
      var d = global.document;
      if (!d || !d.body) return;
      if (!pill) {
        pill = d.createElement('div');
        pill.setAttribute('role', 'status');
        pill.setAttribute('aria-live', 'polite');
        pill.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:92vw;padding:9px 16px;' +
          'border-radius:999px;background:#241b4d;color:#fff;font:600 13px/1.3 system-ui,sans-serif;' +
          'box-shadow:0 6px 24px rgba(0,0,0,.25);z-index:99999;text-align:center;pointer-events:none';
        d.body.appendChild(pill);
      }
      clearTimeout(pillTimer);
      pill.textContent = msg;
      pill.style.display = 'block';
      if (hideAfterMs) pillTimer = setTimeout(hidePill, hideAfterMs);
    } catch (e) { /* cosmetic only */ }
  }
  function hidePill() { if (pill) pill.style.display = 'none'; }

  /* ---------- shared engine state ---------- */
  var worker = null, ready = false, loadPromise = null, files = {}, busy = false, queue = [];
  var stream = null, ctx = null, seg = null, resampler = null, micPromise = null;
  var session = null, idleTimer = null, utt = null, uttSeq = 0, orphan = null, lastLang = 'auto';

  function codeErr(code, msg) { var e = new Error(msg || code); e.voxCode = code; return e; }
  function micCode(e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'not-allowed';
    if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'NotReadableError' || n === 'DevicesNotFoundError') return 'audio-capture';
    return 'start-failed';
  }

  /* ---------- model ---------- */
  function loadModel() {
    if (ready) return Promise.resolve();
    if (loadPromise) return loadPromise;
    loadPromise = new Promise(function (resolve, reject) {
      var w;
      try { w = new global.Worker(WORKER_URL, { type: 'module' }); }
      catch (e) { reject(codeErr('start-failed', e && e.message)); return; }
      worker = w; files = {};
      w.onmessage = function (ev) {
        var m = ev.data || {};
        if (m.type === 'progress') {
          var p = m.p || {};
          if (p.file && p.total) {
            files[p.file] = { l: p.loaded || 0, t: p.total };
            var l = 0, t = 0;
            for (var k in files) { l += files[k].l; t += files[k].t; }
            if (t) say('Downloading offline speech model\u2026 ' + Math.min(99, Math.round(l / t * 100)) + '% (one time only)');
          }
        } else if (m.type === 'status') {
          say(m.message);
        } else if (m.type === 'ready') {
          ready = true;
          w.onmessage = onWorkerMsg;
          say('Offline speech engine ready', 1800);
          resolve();
          pump();
        } else if (m.type === 'error') {
          var net = /speech library|connection|fetch|network|load/i.test(m.message || '');
          reject(codeErr(net ? 'network' : 'start-failed', m.message));
        }
      };
      w.onerror = function (ev) { reject(codeErr('start-failed', ev && ev.message)); };
      say('Preparing offline speech engine\u2026');
      w.postMessage({ type: 'init', model: MODEL, prefer: 'auto' });
    });
    loadPromise.catch(function () {
      try { if (worker) worker.terminate(); } catch (e) { /* ignore */ }
      worker = null; loadPromise = null; ready = false;
      hidePill();
    });
    return loadPromise;
  }

  function pump() {
    if (!ready || busy || !queue.length) return;
    var j = queue.shift();
    busy = true;
    worker.postMessage({ type: 'transcribe', id: j.id, audio: j.audio, final: j.final, language: j.language, rms: j.rms, durationSec: j.dur }, [j.audio.buffer]);
  }
  function enqueue(job) {
    if (job.final) {
      queue = queue.filter(function (j) { return j.final; });   // drop stale previews, keep finished utterances
      queue.push(job);
    } else {
      if (!ready || busy || queue.length) return;               // previews only when the engine is idle
      queue.push(job);
    }
    pump();
  }
  function onWorkerMsg(ev) {
    var m = ev.data || {};
    if (m.type !== 'result') return;
    busy = false;
    deliver(m);
    pump();
    finishCheck();
  }
  function deliver(m) {
    var text = CORE.cleanText(m.text, { rms: m.rms, durationSec: m.durationSec });
    if (m.final) {
      if (m.error && session && (session._state === 'running' || session._state === 'stopping')) { session._fail('start-failed'); return; }
      if (!text) return;
      if (session && (session._state === 'running' || session._state === 'stopping')) { session._emit(text, true); session._end(); }
      else orphan = { text: text, t: Date.now() };
    } else if (text && session && session._state === 'running' && utt && !utt.done && m.id === utt.id) {
      session._emit(text, false);
    }
  }
  function finishCheck() {
    if (session && session._state === 'stopping' && !busy && !queue.length) session._end();
  }

  /* ---------- microphone ---------- */
  function onSegEvent(ev) {
    if (ev.type === 'speechstart') {
      utt = { id: ++uttSeq, done: false };
    } else if (ev.type === 'interim') {
      if (session && session._state === 'running' && utt && !utt.done) {
        var a = ev.audio;
        if (a.length > CORE.SR * 15) a = a.slice(-CORE.SR * 15);
        enqueue({ id: utt.id, final: false, audio: a, language: whisperLang(session.lang) });
      }
    } else if (ev.type === 'final') {
      var id = utt ? utt.id : ++uttSeq;
      if (utt) utt.done = true;
      enqueue({ id: id, final: true, audio: ev.audio, language: whisperLang(session ? session.lang : lastLang), rms: ev.rms, dur: ev.durationSec });
    }
  }

  async function doOpenMic() {
    var s;
    try {
      s = await nav.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    } catch (e) { throw codeErr(micCode(e), e && e.message); }
    var c;
    try {
      c = new AC();
      if (c.state === 'suspended') await c.resume();
      resampler = new CORE.Resampler(c.sampleRate, CORE.SR);
      seg = new CORE.Segmenter({});
      var feed = function (block) {
        if (!resampler || !seg) return;
        var chunk = resampler.process(block);
        if (!chunk.length) return;
        var evs = seg.push(chunk);
        for (var i = 0; i < evs.length; i++) onSegEvent(evs[i]);
      };
      var src = c.createMediaStreamSource(s);
      var sink = c.createGain(); sink.gain.value = 0; sink.connect(c.destination);
      if (c.audioWorklet && global.AudioWorkletNode) {
        var url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
        await c.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        var n = new global.AudioWorkletNode(c, 'vox-cap');
        n.port.onmessage = function (e) { feed(e.data); };
        src.connect(n); n.connect(sink);
      } else {
        var p = c.createScriptProcessor(4096, 1, 1);
        p.onaudioprocess = function (e) { feed(new Float32Array(e.inputBuffer.getChannelData(0))); };
        src.connect(p); p.connect(sink);
      }
    } catch (e) {
      s.getTracks().forEach(function (t) { t.stop(); });
      try { if (c) c.close(); } catch (_) { /* ignore */ }
      throw codeErr('start-failed', e && e.message);
    }
    stream = s; ctx = c;
  }
  function openMic() {
    if (stream && stream.active && ctx && ctx.state !== 'closed') {
      return ctx.state === 'suspended' ? ctx.resume().catch(function () {}) : Promise.resolve();
    }
    if (!micPromise) {
      micPromise = doOpenMic().then(function () { micPromise = null; }, function (e) { micPromise = null; throw e; });
    }
    return micPromise;
  }
  function closeMic() {
    try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
    try { if (ctx) ctx.close(); } catch (e) { /* ignore */ }
    stream = null; ctx = null; seg = null; resampler = null; utt = null;
  }

  /* ---------- SpeechRecognition-compatible session ---------- */
  function Rec() {
    this.lang = 'en-US';
    this.continuous = false;
    this.interimResults = true;
    this.maxAlternatives = 1;
    this.onstart = this.onresult = this.onerror = this.onend = null;
    this._state = 'idle';
  }
  Rec.prototype._fire = function (name, ev) {
    var f = this['on' + name];
    if (typeof f !== 'function') return;
    try { f.call(this, ev || {}); } catch (e) { if (global.console) console.error(e); }
  };
  Rec.prototype._emit = function (text, isFinal) {
    if (!isFinal && !this.interimResults) return;
    var res = [{ transcript: text, confidence: isFinal ? 0.9 : 0.5 }];
    res.isFinal = isFinal;
    res.item = function (i) { return this[i]; };
    var results = [res];
    results.item = function (i) { return this[i]; };
    this._fire('result', { resultIndex: 0, results: results });
  };
  Rec.prototype._fail = function (code) {
    if (this._state === 'ended' || this._state === 'idle') return;
    this._fire('error', { error: code, message: code });
    this._end();
  };
  Rec.prototype._end = function () {
    if (this._state === 'ended' || this._state === 'idle') return;
    this._state = 'ended';
    if (session === this) {
      session = null;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(function () { if (!session) closeMic(); }, IDLE_MS);
    }
    var self = this;
    setTimeout(function () { self._fire('end'); }, 0);
  };
  Rec.prototype.start = function () {
    var st = this._state;
    if (st === 'starting' || st === 'running' || st === 'stopping') {
      var err = new Error('recognition has already started'); err.name = 'InvalidStateError'; throw err;
    }
    var self = this;
    this._state = 'starting';
    if (session && session !== this) session._end();
    session = this; lastLang = this.lang;
    clearTimeout(idleTimer);
    openMic().then(function () {
      if (self._state !== 'starting') return;
      self._state = 'running';
      self._fire('start');
      if (orphan && Date.now() - orphan.t < ORPHAN_MS) {
        var t = orphan.text; orphan = null;
        self._emit(t, true); self._end();
        return;
      }
      orphan = null;
      if (!ready) loadModel().catch(function (e) { self._fail((e && e.voxCode) || 'start-failed'); });
    }).catch(function (e) { self._fail((e && e.voxCode) || 'start-failed'); });
  };
  Rec.prototype.stop = function () {
    if (this._state === 'starting') { this._end(); return; }
    if (this._state !== 'running') return;
    this._state = 'stopping';
    if (seg) {
      var evs = seg.flush();
      for (var i = 0; i < evs.length; i++) onSegEvent(evs[i]);
    }
    finishCheck();
  };
  Rec.prototype.abort = function () {
    if (this._state === 'starting' || this._state === 'running' || this._state === 'stopping') this._end();
  };

  global.VoxWhisperRecognition = Rec;
  global.VoxWhisper = { preload: loadModel };
})(typeof window !== 'undefined' ? window : this);

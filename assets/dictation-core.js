/* Voxoira on-device dictation: pure logic, no DOM, no model.
   Works in the browser (window.VoxCore) and in Node (module.exports) so it can be unit-tested. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoxCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SR = 16000;            // Whisper sample rate
  const FRAME = 480;           // 30 ms at 16 kHz

  /* ---------- streaming resampler (box-average downsampling) ---------- */
  class Resampler {
    constructor(fromRate, toRate) {
      this.ratio = fromRate / toRate;
      this.same = fromRate === toRate;
      this.pos = 0;
      this.tail = new Float32Array(0);
    }
    process(input) {
      if (this.same) return input;
      let data = input;
      if (this.tail.length) {
        data = new Float32Array(this.tail.length + input.length);
        data.set(this.tail, 0);
        data.set(input, this.tail.length);
      }
      const out = [];
      const w = Math.max(1, Math.round(this.ratio));
      let pos = this.pos;
      while (Math.floor(pos) + w <= data.length) {
        const i = Math.floor(pos);
        let sum = 0;
        for (let k = 0; k < w; k++) sum += data[i + k];
        out.push(sum / w);
        pos += this.ratio;
      }
      const keep = Math.min(Math.floor(pos), data.length);
      this.tail = data.slice(keep);
      this.pos = pos - keep;
      return Float32Array.from(out);
    }
  }

  /* ---------- speech segmenter (energy VAD with hysteresis + adaptive noise floor) ---------- */
  class Segmenter {
    constructor(opts) {
      const o = Object.assign({
        pauseMs: 800,          // silence that ends an utterance
        softCutAfterSec: 18,   // after this long, a short pause is enough to cut
        softPauseMs: 300,
        maxSec: 25,            // hard cut (Whisper window is 30 s)
        minSpeechMs: 300,      // ignore shorter blips
        preRollMs: 300,
        startMs: 90,           // speech must persist this long to start
        interimMs: 1500,       // how often to emit a partial while speaking
        sensitivity: 1         // >1 = more sensitive
      }, opts || {});
      this.o = o;
      this.buf = new Float32Array(0);
      this.noise = 0.004;
      this.inSpeech = false;
      this.preroll = [];       // frames
      this.frames = [];        // frames of current utterance
      this.speechRun = 0;      // consecutive loud frames (not yet in speech)
      this.silenceRun = 0;     // consecutive quiet frames (in speech)
      this.sinceInterim = 0;
      this.loudFrames = 0;
    }
    get frameMs() { return FRAME / SR * 1000; }
    threshold() { return Math.max(0.008, this.noise * 3) / this.o.sensitivity; }
    static rms(f) { let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i]; return Math.sqrt(s / f.length); }

    push(chunk) {
      const events = [];
      let data = chunk;
      if (this.buf.length) { data = new Float32Array(this.buf.length + chunk.length); data.set(this.buf); data.set(chunk, this.buf.length); }
      let i = 0;
      for (; i + FRAME <= data.length; i += FRAME) this._frame(data.slice(i, i + FRAME), events);
      this.buf = data.slice(i);
      return events;
    }

    _frame(f, ev) {
      const o = this.o, ms = this.frameMs, r = Segmenter.rms(f);
      const on = this.threshold(), off = on * 0.6;
      const loud = this.inSpeech ? r > off : r > on;

      if (!this.inSpeech) {
        // adapt noise floor only on quiet frames
        if (!loud) this.noise = this.noise * 0.95 + r * 0.05;
        this.preroll.push(f);
        const maxPre = Math.ceil(o.preRollMs / ms);
        while (this.preroll.length > maxPre) this.preroll.shift();
        this.speechRun = loud ? this.speechRun + 1 : 0;
        if (this.speechRun * ms >= o.startMs) {
          this.inSpeech = true;
          this.frames = this.preroll.slice();
          this.preroll = [];
          this.silenceRun = 0; this.sinceInterim = 0; this.loudFrames = this.speechRun;
          ev.push({ type: 'speechstart' });
        }
        return;
      }

      this.frames.push(f);
      if (loud) { this.silenceRun = 0; this.loudFrames++; } else this.silenceRun++;
      this.sinceInterim += ms;
      const dur = this.frames.length * ms / 1000;
      const needPause = dur >= o.softCutAfterSec ? o.softPauseMs : o.pauseMs;

      if (this.silenceRun * ms >= needPause) { this._end(ev, 'pause'); return; }
      if (dur >= o.maxSec) { this._end(ev, 'max'); return; }
      if (this.sinceInterim >= o.interimMs) {
        this.sinceInterim = 0;
        ev.push({ type: 'interim', audio: this._audio(), durationSec: dur });
      }
    }

    _audio(trimTail) {
      let frames = this.frames;
      if (trimTail) frames = frames.slice(0, Math.max(1, frames.length - Math.max(0, this.silenceRun - 3))); // keep ~90 ms of tail
      const out = new Float32Array(frames.length * FRAME);
      frames.forEach((fr, k) => out.set(fr, k * FRAME));
      return out;
    }

    _end(ev, reason) {
      const ms = this.frameMs;
      const speechMs = this.loudFrames * ms;
      const audio = this._audio(reason === 'pause');
      if (speechMs >= this.o.minSpeechMs) {
        ev.push({ type: 'final', audio, durationSec: audio.length / SR, reason, rms: Segmenter.rms(audio) });
      } else {
        ev.push({ type: 'discard' });
      }
      this.inSpeech = false; this.frames = []; this.speechRun = 0; this.silenceRun = 0; this.loudFrames = 0;
      this.preroll = [];
    }

    /** call when the microphone stops */
    flush() {
      const ev = [];
      if (this.inSpeech) this._end(ev, 'stop');
      return ev;
    }
  }

  /* ---------- clean Whisper output ---------- */
  // Phrases Whisper tends to invent from training-data habits. STRONG ones are dropped on quiet OR very short clips;
  // WEAK ones are also things people really say, so they are dropped only when the audio is genuinely quiet.
  const PHANTOM_STRONG = /^(thanks? for watching|please subscribe|subtitles? by.*|amara\.org.*|translated by.*)[.!? ]*$/i;
  const PHANTOM_WEAK = /^(thanks? you( so much)?|you|bye|bye-bye|okay|ok|the end|\.+)[.!? ]*$/i;
  function cleanText(text, info) {
    let t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    // sound/silence tags such as [BLANK_AUDIO], (silence), [Music]
    t = t.replace(/\s*[\[(]\s*(blank[_ ]audio|silence|music|noise|inaudible|applause|laughter|no audio)[^\])]*[\])]\s*/gi, ' ').trim();
    if (/^[\[(][^\])]*[\])]$/.test(t)) return '';
    // looping repetition: a phrase of 1-6 words repeated 4+ times -> keep once
    t = t.replace(/(\b[\w'’-]+(?:\s+[\w'’-]+){0,5}[.,!?]?)(?:\s+\1){3,}/gi, '$1');
    // phantom phrases Whisper invents on near-silence
    const quiet = info && typeof info.rms === 'number' && info.rms < 0.02;
    const short = info && typeof info.durationSec === 'number' && info.durationSec < 1.2;
    if (PHANTOM_STRONG.test(t) && (quiet || short)) return '';
    if (PHANTOM_WEAK.test(t) && quiet) return '';
    return t.trim();
  }

  /* ---------- spoken commands (only when the whole utterance is the command) ---------- */
  const CMD = {
    'new line': 'newline', 'newline': 'newline', 'next line': 'newline',
    'new paragraph': 'paragraph', 'next paragraph': 'paragraph',
    'scratch that': 'scratch', 'delete that': 'scratch', 'undo that': 'scratch', 'strike that': 'scratch',
    'stop listening': 'stop', 'stop dictation': 'stop', 'stop recording': 'stop'
  };
  function parseCommand(text) {
    const k = String(text || '').toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
    return CMD[k] || null;
  }

  /* ---------- insert text at a caret with sensible spacing ---------- */
  function insertSmart(value, start, end, text) {
    const before = value.slice(0, start), after = value.slice(end);
    const prev = before.slice(-1), next = after.slice(0, 1);
    const startsPunct = /^[.,;:!?)\]”’%]/.test(text);
    const startsBreak = /^\n/.test(text);
    let lead = '';
    if (prev && !/\s/.test(prev) && !startsPunct && !startsBreak && !/[(\[“‘]$/.test(before)) lead = ' ';
    let trail = '';
    if (next && !/\s/.test(next) && !/[.,;:!?)\]”’%]/.test(next) && !/\s$/.test(text) && !/\n$/.test(text)) trail = ' ';
    const ins = lead + text + trail;
    return { value: before + ins + after, caret: before.length + lead.length + text.length + trail.length, insertedStart: before.length, insertedText: ins };
  }

  return { Resampler, Segmenter, cleanText, parseCommand, insertSmart, SR, FRAME };
});

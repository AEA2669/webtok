'use strict';
(() => {
/* =========================================================
   Constants & small utilities
========================================================= */
const $ = id => document.getElementById(id);
const TARGET_RATE = 16000;
const FRAME = 480;              // 30 ms @ 16 kHz
const STREAM_CHUNK = 1600;      // 100 ms @ 16 kHz
const LS_SETTINGS = 'webtok.settings.v2';
const LS_KEYS = 'webtok.keys.v2';
const LS_HISTORY = 'webtok.history.v2';
const MAX_HISTORY = 20;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function fmtClock(sec){
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
  return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
function srtTime(sec){
  sec = Math.max(0, sec || 0);
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000), r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
}

function checkUrl(u, allowAnyHttp = false){
  let url;
  try{ url = new URL(String(u || '').trim(), location.href); }catch{ throw new Error('Invalid URL: ' + u); }
  if(location.protocol !== 'file:' && url.origin === location.origin) return url.href;
  const localHosts = ['localhost', '127.0.0.1', '[::1]'];
  if(url.protocol === 'https:') return url.href;
  if(url.protocol === 'http:' && (allowAnyHttp || localHosts.includes(url.hostname))) return url.href;
  throw new Error('URL must use https:// (or http://localhost): ' + u);
}
function requireKey(k, provider){
  const key = String(k || '').trim();
  if(!key) throw new Error(`${provider}: API key is required (see engine settings).`);
  return key;
}
function parseJSONField(text, label){
  const t = String(text || '').trim();
  if(!t) return {};
  try{
    const v = JSON.parse(t);
    if(v && typeof v === 'object' && !Array.isArray(v)) return v;
  }catch{}
  throw new Error(`${label} must be a JSON object.`);
}
function getPath(obj, path){
  if(!path) return undefined;
  return String(path).split('.').reduce((o, k) =>
    (o != null && Object.prototype.hasOwnProperty.call(o, k)) ? o[k] : undefined, obj);
}
async function safeFetch(url, init, provider){
  try{ return await fetch(url, init); }
  catch(e){ throw new Error(`${provider}: network/CORS error (${e.message}). Check connectivity, proxy, or CORS policy.`); }
}
async function httpError(res, provider){
  let detail = '';
  try{
    const t = await res.text();
    try{
      const j = JSON.parse(t);
      detail = j.error?.message || (typeof j.error === 'string' ? j.error : '') || j.err_msg || j.message || t;
    }catch{ detail = t; }
  }catch{}
  return new Error(`${provider} HTTP ${res.status}: ${String(detail).slice(0, 300)}`);
}

const scriptCache = new Map();
function loadScript(src){
  if(!scriptCache.has(src)){
    scriptCache.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.crossOrigin = 'anonymous';
      s.onload = resolve;
      s.onerror = () => { scriptCache.delete(src); s.remove(); reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    }));
  }
  return scriptCache.get(src);
}

/* ---------- Audio encoding ---------- */
function floatToInt16(f32){
  const out = new Int16Array(f32.length);
  for(let i = 0; i < f32.length; i++){
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}
function encodeWAV(f32, rate = TARGET_RATE){
  const pcm = floatToInt16(f32);
  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const v = new DataView(buf);
  const w = (o, s) => { for(let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.byteLength, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}
function bytesToBase64(u8){
  let s = '';
  for(let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
async function decodeFileTo16k(file){
  const data = await file.arrayBuffer();
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  let buf;
  try{ buf = await ac.decodeAudioData(data); }
  catch{ throw new Error('Could not decode this file. Try WAV, MP3, M4A, OGG or WEBM.'); }
  finally{ ac.close().catch(() => {}); }
  const off = new OfflineAudioContext(1, Math.ceil(buf.duration * TARGET_RATE), TARGET_RATE);
  const src = off.createBufferSource();
  src.buffer = buf; src.connect(off.destination); src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

/* =========================================================
   Logging & status
========================================================= */
const logEl = $('log');
function log(msg, level = 'info'){
  const line = document.createElement('div');
  line.className = 'log-' + level;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logEl.prepend(line);
  while(logEl.childElementCount > 300) logEl.lastElementChild.remove();
}
const statusEl = $('status'), statusPill = $('statusPill');
function setStatus(text, state = 'idle'){
  statusEl.textContent = text;
  statusEl.title = text;
  statusPill.dataset.state = state;
}
const progressEl = $('progress'), progressBar = $('progressBar'), progressText = $('progressText');
function showProgress(p, text){
  if(p === null || p === undefined){ progressEl.hidden = true; return; }
  progressEl.hidden = false;
  progressEl.classList.toggle('indeterminate', p < 0);
  progressBar.style.width = p < 0 ? '' : Math.round(Math.min(1, p) * 100) + '%';
  progressText.textContent = text || '';
}
let alertTimer = null;
function flashAlert(text, sticky = false){
  const el = $('alertBanner');
  el.textContent = text; el.hidden = false;
  clearTimeout(alertTimer);
  if(!sticky) alertTimer = setTimeout(() => { el.hidden = true; }, 10000);
}

/* =========================================================
   Aviation vocabulary & post-processing
========================================================= */
const DEFAULT_VOCAB = `# Terms to boost (one per line). Add "heard => intended" for correction rules.
runway
taxiway
cleared
squawk
flight level
heading
altimeter
ATIS
METAR
TAF
NOTAM
ILS
VOR
RNAV
ETOPS
MEL
AOG
MX
tail number
allocator
allocated
reallocated
aircraft swap
inbound
outbound
turn time
ground time
delay code
ETD
ETA
crew scheduling
ramp
gate agent
load planner
pushback
deice
jet bridge
logbook
maintenance
dispatch
diversion
go-around
holding
transponder
interrupt
interruption
more internal => more interrupt
interupt => interrupt
interuption => interruption
maintenance on the flight time => maintenance on the flight
jet way => jetway
d ice => deice
`;

function parseVocab(text){
  const terms = [], rules = [];
  for(const raw of String(text || '').split(/\r?\n/)){
    const line = raw.trim();
    if(!line || line.startsWith('#')) continue;
    const m = line.split('=>');
    if(m.length === 2){
      const from = m[0].trim(), to = m[1].trim();
      if(from) rules.push({ re: new RegExp('\\b' + escapeRegExp(from) + '\\b', 'gi'), to });
      if(to && !terms.includes(to)) terms.push(to);
    } else if(!terms.includes(line)) terms.push(line);
  }
  return { terms, rules };
}

const DIGIT_WORDS = { zero:0, one:1, two:2, three:3, tree:3, four:4, fower:4, five:5, fife:5, six:6, seven:7, eight:8, nine:9, niner:9 };
const TEENS = { ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17, eighteen:18, nineteen:19 };
const TENS = { twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90 };
const NATO = { alpha:'A', alfa:'A', bravo:'B', charlie:'C', delta:'D', echo:'E', foxtrot:'F', golf:'G', hotel:'H', india:'I',
  juliet:'J', juliett:'J', kilo:'K', lima:'L', mike:'M', november:'N', oscar:'O', papa:'P', quebec:'Q', romeo:'R', sierra:'S',
  tango:'T', uniform:'U', victor:'V', whiskey:'W', whisky:'W', 'x-ray':'X', xray:'X', yankee:'Y', zulu:'Z' };
const NUMBER_CONTEXT = /^(flight|runway|heading|level|fl|squawk|gate|altitude|climb|descend|maintain|contact|frequency|decimal|point|taxiway|information|seat|row|bay|stand|speed|knots|miles|feet|thousand|hundred|number|tail|ship|fin|zone|door)$/i;
const AIRLINES = new Set(['american','united','delta','southwest','jetblue','alaska','spirit','frontier','envoy','piedmont','republic',
  'skywest','mesa','allegiant','hawaiian','speedbird','lufthansa','cactus','brickyard','westjet','jazz','sun country','breeze']);
const SAFE_AIRPORTS = ['dfw','dca','lax','jfk','ord','clt','phl','phx','lga','ewr','iad','bwi','atl','sfo','iah','msp','dtw','slc','pdx',
  'sjc','mco','tpa','fll','rdu','bna','stl','mci','cvg','cle','cmh','pit','ind','mke','msy','mdw','abq','tus','okc','elp','lhr','cdg','nrt','hnd','yyz','yul','cun','sju','rsw','pbi','jax','chs','sav','dsm','oma','ict','tul','xna','lit','shv'];
const AMBIG_AIRPORTS = ['sea','den','san','mia','bos','aus','mem','buf','ric','oak','sat','sna','hnl','ogg','anc','hou','dal','bur','ont','lgb','orf','bdl','alb','syr','roc'];
const FILLERS = /(^|\s)(uh+|um+|uhm+|erm+|er|hmm+|you know|i mean)(?=[\s,.!?]|$)[,]?/gi;
const EMERGENCY = /\b(mayday|pan[\s-]?pan|squawk\s+7[567]00|7700|7600|7500|emergency|fire|smoke|evacuat\w*|hijack\w*)\b/i;
const COMMON_WORDS = new Set(['there','their','where','which','would','could','should','about','other','these','those','after','before','right','left','first','still','again','going','being','think','every','under','while','flight','today','later','hours','minutes']);

function tokenize(s){
  return s.split(' ').filter(Boolean).map(t => {
    const m = t.match(/^(\W*)(.*?)(\W*)$/);
    return { pre: m[1], core: m[2], post: m[3] };
  });
}
const detok = toks => toks.map(t => t.pre + t.core + t.post).join(' ');
const isSingleDigit = c => (c.toLowerCase() in DIGIT_WORDS) || /^\d$/.test(c);
const digitOf = c => { const l = c.toLowerCase(); return l in DIGIT_WORDS ? String(DIGIT_WORDS[l]) : c; };

/* Joins spoken digit / NATO runs: "two seven lima" -> "27L", "one two three four" -> "1234" */
function convertTokens(tokens, strict){
  const out = [];
  let i = 0;
  while(i < tokens.length){
    let j = i, nato = 0, digits = 0, allSingle = true;
    while(j < tokens.length){
      const c = tokens[j].core.toLowerCase();
      const isNato = c in NATO;
      const isDig = (c in DIGIT_WORDS) || /^\d+$/.test(c);
      if(!isNato && !isDig) break;
      if(j > i && /[.!?;:]/.test(tokens[j - 1].post)) break;
      if(isNato) nato++; else { digits++; if(!isSingleDigit(c)) allSingle = false; }
      j++;
    }
    if(j === i){ out.push(tokens[i]); i++; continue; }

    const run = tokens.slice(i, j);
    const prev = out.length ? out[out.length - 1].core.toLowerCase() : '';
    const next = tokens[j] ? tokens[j].core.toLowerCase() : '';
    const ctx = NUMBER_CONTEXT.test(prev) || AIRLINES.has(prev);
    const first = run[0], last = run[run.length - 1];
    const make = core => ({ pre: first.pre, core, post: last.post });

    if(nato === 0){
      if(run.length >= 2 && allSingle){ out.push(make(run.map(t => digitOf(t.core)).join(''))); i = j; continue; }
      if(run.length === 1 && (first.core.toLowerCase() in DIGIT_WORDS) &&
         (ctx || strict || /^(thousand|hundred|decimal|point)$/.test(next) || /^\d/.test(prev))){
        out.push(make(digitOf(first.core))); i = j; continue;
      }
      out.push(...run);
      i = j; continue;
    }

    const firstLow = first.core.toLowerCase();
    if(firstLow === 'delta' && nato === 1 && digits >= 1 && allSingle){
      out.push({ pre: first.pre, core: 'Delta', post: '' });
      out.push({ pre: '', core: run.slice(1).map(t => digitOf(t.core)).join(''), post: last.post });
      i = j; continue;
    }
    if(nato >= 2 || strict || ctx || (firstLow === 'november' && digits > 0)){
      out.push(make(run.map(t => { const c = t.core.toLowerCase(); return c in NATO ? NATO[c] : digitOf(t.core); }).join('')));
      i = j; continue;
    }
    out.push(tokens[i]); i++;
  }
  return out;
}

function levenshtein(a, b){
  if(a === b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, k) => k);
  for(let i = 1; i <= m; i++){
    const cur = [i];
    for(let k = 1; k <= n; k++) cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

function cleanTranscript(raw, { strict = false, vocab = { terms: [], rules: [] } } = {}){
  if(!raw) return '';
  let s = String(raw).replace(/\s+/g, ' ').trim();

  // user correction rules first, so they see the raw wording
  for(const r of vocab.rules) s = s.replace(r.re, r.to);

  // tens / teens -> digits
  const unitRe = Object.keys(DIGIT_WORDS).filter(k => DIGIT_WORDS[k] > 0).join('|');
  s = s.replace(new RegExp(`\\b(${Object.keys(TENS).join('|')})[\\s-](${unitRe})\\b`, 'gi'),
    (m, t, u) => String(TENS[t.toLowerCase()] + DIGIT_WORDS[u.toLowerCase()]));
  s = s.replace(new RegExp(`\\b(${Object.keys(TENS).join('|')}|${Object.keys(TEENS).join('|')})\\b`, 'gi'),
    m => String(TENS[m.toLowerCase()] ?? TEENS[m.toLowerCase()]));

  s = detok(convertTokens(tokenize(s), strict));

  // numeric forms
  s = s.replace(/\b(\d+)\s+(?:decimal|point)\s+(\d+)\b/gi, '$1.$2');
  s = s.replace(/\b(\d{1,2})\s+thousand(?:\s+(\d)\s+hundred)?\b/gi, (m, a, b) => String(+a * 1000 + (b ? +b * 100 : 0)));
  s = s.replace(/\b(\d{1,2})\s+hundred\b/gi, (m, a) => String(+a * 100));

  // aviation patterns
  s = s.replace(/\b(?:flight\s+level|FL)\s*(\d{2,3})\b/gi, 'FL$1');
  s = s.replace(/\brunway\s+(\d{1,2})\s*(left|right|center|centre|L|R|C)?\b/gi, (m, n, side) =>
    'runway ' + n + (side ? side[0].toUpperCase() : ''));
  s = s.replace(/\bheading\s+(\d{1,3})\b/gi, (m, n) => 'heading ' + n.padStart(3, '0'));
  s = s.replace(/\bsquawk(ing)?\s+(\d{4})\b/gi, (m, ing, n) => 'squawk' + (ing || '') + ' ' + n);
  s = s.replace(/\b(climb|descend|maintain|altitude)((?:\s+and\s+maintain|\s+to)?)\s+(\d{4,5})\b(?!\.\d)/gi,
    (m, verb, mid, n) => `${verb}${mid} ${Number(n).toLocaleString('en-US')}`);
  s = s.replace(/\bflight\s+(?:number\s+|no\.?\s*|time\s+|#\s*)?(\d{1,5}[A-Z]?)\b/gi, 'Flight $1');
  s = s.replace(/\bflight(\d{2,5})\b/gi, 'Flight $1');
  s = s.replace(/\bmy\s+(\d{3,4})\b/gi, 'Flight $1');
  s = s.replace(/\b([a-z]+)\s+(\d{1,5})\b/gi, (m, w, n) =>
    AIRLINES.has(w.toLowerCase()) ? w[0].toUpperCase() + w.slice(1).toLowerCase() + ' ' + n : m);

  // airport codes
  s = s.replace(new RegExp(`\\b(${SAFE_AIRPORTS.join('|')})\\b`, 'gi'), m => m.toUpperCase());
  s = s.replace(new RegExp(`\\b(to|from|at|into|via|for|departing|arriving|out of)\\s+(${AMBIG_AIRPORTS.join('|')})\\b`, 'gi'),
    (m, p, c) => `${p} ${c.toUpperCase()}`);

  // vocabulary casing (acronyms / multi-word terms)
  for(const t of vocab.terms){
    if(/[A-Z]/.test(t) || /\s/.test(t)) s = s.replace(new RegExp('\\b' + escapeRegExp(t) + '\\b', 'gi'), t);
  }

  if(strict){
    s = s.replace(FILLERS, '$1');
    const single = vocab.terms.filter(t => /^[a-z-]{7,}$/i.test(t));
    if(single.length){
      s = s.replace(/\b[a-z][a-z-]{4,}\b/gi, w => {
        const lw = w.toLowerCase();
        if(COMMON_WORDS.has(lw)) return w;
        for(const t of single){
          const lt = t.toLowerCase();
          if(lt === lw) return w;
          if(lt[0] !== lw[0]) continue;
          if(Math.abs(lw.length - lt.length) <= 1 && levenshtein(lw, lt) === 1) return t;
        }
        return w;
      });
    }
  }

  // collapse stutter/hallucinated repeats: "go-around go-around" -> "go-around"
  s = s.replace(/\b((?:[\w'-]+\s+){0,3}[\w'-]+)(?:[\s,]+\1\b)+/gi, '$1');
  s = s.replace(/\s+([,.!?;:])/g, '$1').replace(/([,.!?])\1+/g, '$1').replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/^[,.;:\s]+/, '');
  if(s) s = s[0].toUpperCase() + s.slice(1);
  return s;
}

/* Token-level LCS diff; returns [{t, changed}] for the corrected text */
function diffTokens(a, b){
  const A = a.split(/\s+/).filter(Boolean), B = b.split(/\s+/).filter(Boolean);
  const norm = t => t.toLowerCase().replace(/[^\w.]/g, '');
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for(let i = n - 1; i >= 0; i--)
    for(let j = m - 1; j >= 0; j--)
      dp[i][j] = norm(A[i]) === norm(B[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while(j < m){
    if(i < n && norm(A[i]) === norm(B[j])){ out.push({ t: B[j], changed: false }); i++; j++; }
    else if(i < n && dp[i + 1][j] >= dp[i][j + 1]) i++;
    else { out.push({ t: B[j], changed: true }); j++; }
  }
  return out;
}
function renderDiff(el, raw, clean){
  el.replaceChildren();
  diffTokens(raw, clean).forEach((tok, idx) => {
    if(idx) el.append(' ');
    if(tok.changed){
      const span = document.createElement('span');
      span.className = 'highlight';
      span.textContent = tok.t;
      el.append(span);
    } else el.append(tok.t);
  });
}

function vocabHits(text, terms){
  const low = text.toLowerCase();
  let hits = 0;
  for(const t of terms) if(new RegExp('\\b' + escapeRegExp(t.toLowerCase()) + '\\b').test(low)) hits++;
  return hits;
}
function pickBestAlternative(alts, terms){
  let best = alts[0], bestScore = -Infinity;
  alts.forEach((a, idx) => {
    if(!a.text) return;
    const score = (a.confidence ?? 0.5) + 0.02 * vocabHits(a.text, terms) - 0.03 * idx;
    if(score > bestScore){ bestScore = score; best = a; }
  });
  return best;
}

/* =========================================================
   Audio pipeline: mic -> gain -> analyser + 16 kHz PCM tap
========================================================= */
const WORKLET_SRC = `
class PcmTap extends AudioWorkletProcessor{
  constructor(){ super(); this.ratio = sampleRate / ${TARGET_RATE}; this.pos = 0; this.last = 0; this.buf = new Float32Array(${FRAME}); this.n = 0; }
  process(inputs){
    const ch = inputs[0] && inputs[0][0];
    if(!ch) return true;
    const len = ch.length;
    let pos = this.pos;
    while(pos <= len - 1){
      const i = Math.floor(pos), f = pos - i;
      const a = i < 0 ? this.last : ch[i];
      const b = i + 1 < len ? ch[i + 1] : ch[len - 1];
      this.buf[this.n++] = a + (b - a) * f;
      if(this.n === this.buf.length){ this.port.postMessage(this.buf); this.buf = new Float32Array(${FRAME}); this.n = 0; }
      pos += this.ratio;
    }
    this.pos = pos - len; this.last = ch[len - 1];
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);`;

class Resampler{
  constructor(inRate, onFrame){ this.ratio = inRate / TARGET_RATE; this.pos = 0; this.last = 0; this.buf = new Float32Array(FRAME); this.n = 0; this.onFrame = onFrame; }
  push(ch){
    const len = ch.length;
    let pos = this.pos;
    while(pos <= len - 1){
      const i = Math.floor(pos), f = pos - i;
      const a = i < 0 ? this.last : ch[i];
      const b = i + 1 < len ? ch[i + 1] : ch[len - 1];
      this.buf[this.n++] = a + (b - a) * f;
      if(this.n === FRAME){ this.onFrame(this.buf); this.buf = new Float32Array(FRAME); this.n = 0; }
      pos += this.ratio;
    }
    this.pos = pos - len; this.last = ch[len - 1];
  }
}

const GATE_LOOKAHEAD = 4;
const gateLevel = v => v > 0 ? 0.004 * Math.pow(25, v / 10) : 0;
class AudioPipeline{
  constructor(){ this.listeners = new Set(); this.gate = { level: 0, ptt: false, held: false, openUntil: 0, open: true }; }
  onFrame(fn){ this.listeners.add(fn); return () => this.listeners.delete(fn); }
  setGate(level, ptt){ this.gate.level = level; this.gate.ptt = ptt; if(!ptt) this.gate.held = false; }
  setTalk(held){ this.gate.held = held; }
  async start({ deviceId, noiseSuppression, echoCancellation, autoGainControl, gain }){
    if(!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone API unavailable (page must be served over https or localhost/file).');
    const audio = { channelCount: 1, noiseSuppression, echoCancellation, autoGainControl };
    try{
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...audio, deviceId: { exact: deviceId } } : audio });
    }catch(e){
      if(deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')){
        log('Selected microphone unavailable, falling back to default.', 'warn');
        this.stream = await navigator.mediaDevices.getUserMedia({ audio });
      } else if(e.name === 'NotAllowedError') throw new Error('Microphone permission denied.');
      else if(e.name === 'NotFoundError') throw new Error('No microphone found.');
      else throw e;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    try{
      this.ctx = new AC({ sampleRate: TARGET_RATE });
      this.src = this.ctx.createMediaStreamSource(this.stream);
    }catch{
      this.ctx?.close().catch(() => {});
      this.ctx = new AC();
      this.src = this.ctx.createMediaStreamSource(this.stream);
    }
    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = gain;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.mute = this.ctx.createGain();
    this.mute.gain.value = 0;
    this.mute.connect(this.ctx.destination);
    this.src.connect(this.gainNode);
    this.gainNode.connect(this.analyser);
    // Lets Chrome SpeechRecognition hear the selected mic with our gain / noise settings.
    // The delay gives the gate lookahead so word onsets aren't clipped.
    this.delay = this.ctx.createDelay(1);
    this.delay.delayTime.value = GATE_LOOKAHEAD * FRAME / TARGET_RATE;
    this.gateNode = this.ctx.createGain();
    this.dest = this.ctx.createMediaStreamDestination();
    this.gainNode.connect(this.delay);
    this.delay.connect(this.gateNode);
    this.gateNode.connect(this.dest);
    this.processedTrack = this.dest.stream.getAudioTracks()[0] || null;

    this.samples = 0;
    this.fifo = [];
    const silence = new Float32Array(FRAME);
    const emit = f => {
      let sum = 0;
      for(let i = 0; i < f.length; i++) sum += f[i] * f[i];
      const rms = Math.sqrt(sum / f.length);
      this.samples += f.length;
      const t = this.samples / TARGET_RATE, g = this.gate;
      let open = true;
      if(g.ptt){
        if(g.held) g.openUntil = t + 0.35;
        open = g.held || t < g.openUntil;
      } else if(g.level > 0){
        if(rms > g.level) g.openUntil = t + 0.6;
        open = t < g.openUntil;
      }
      if(open !== g.open){
        g.open = open;
        this.gateNode.gain.setTargetAtTime(open ? 1 : 0, this.ctx.currentTime, 0.01);
        this.onGate?.(open);
      }
      this.fifo.push(f);
      if(this.fifo.length <= GATE_LOOKAHEAD) return;
      const out = open ? this.fifo.shift() : (this.fifo.shift(), silence);
      for(const fn of this.listeners) fn(out);
    };
    try{
      // file:// pages get an opaque origin, so blob: worklet modules are always refused.
      if(location.protocol === 'file:') throw new Error('file origin');
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.tap = new AudioWorkletNode(this.ctx, 'pcm-tap');
      this.tap.port.onmessage = e => emit(e.data);
    }catch{
      if(location.protocol !== 'file:') log('AudioWorklet unavailable; using ScriptProcessor fallback.', 'warn');
      const rs = new Resampler(this.ctx.sampleRate, emit);
      this.tap = this.ctx.createScriptProcessor(2048, 1, 1);
      this.tap.onaudioprocess = e => rs.push(e.inputBuffer.getChannelData(0));
    }
    this.gainNode.connect(this.tap);
    this.tap.connect(this.mute);
    if(this.ctx.state === 'suspended') await this.ctx.resume();
    this.label = this.stream.getAudioTracks()[0]?.label || '';
  }
  setGain(v){ if(this.gainNode) this.gainNode.gain.value = v; }
  stop(){
    this.listeners.clear();
    this.stream?.getTracks().forEach(t => t.stop());
    this.ctx?.close().catch(() => {});
    this.processedTrack?.stop();
    this.stream = this.ctx = this.analyser = this.tap = this.dest = this.processedTrack = this.gateNode = null;
  }
}

/* =========================================================
   Energy VAD with adaptive noise floor
========================================================= */
class VAD{
  constructor(sensitivity = 6, cb = {}){
    this.factor = 1.6 + (10 - sensitivity) * 0.45;
    this.cb = cb;
    this.floor = 0.008;
    this.speaking = false; this.above = 0; this.below = 0;
    this.pre = []; this.cur = []; this.samples = 0; this.segStart = 0;
    this.voiced = 0;
    this.PRE = 10; this.START = 3; this.HANG = 24; this.KEEP_TAIL = 8; this.MIN = 12; this.MIN_VOICED = 8; this.MAX = Math.round(25000 / 30);
  }
  process(frame){
    let sum = 0;
    for(let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    const thr = Math.max(0.01, this.floor * this.factor);
    const t = this.samples / TARGET_RATE;
    this.samples += frame.length;
    if(!this.speaking){
      this.floor = rms < this.floor ? this.floor * 0.9 + rms * 0.1 : this.floor * 0.995 + rms * 0.005;
      this.pre.push(frame);
      if(this.pre.length > this.PRE) this.pre.shift();
      if(rms > thr){
        if(++this.above >= this.START){
          this.speaking = true;
          this.segStart = t - (this.pre.length - 1) * FRAME / TARGET_RATE;
          this.cur = this.pre; this.pre = []; this.below = 0; this.voiced = this.above;
          this.cb.onStart?.(this.segStart);
        }
      } else this.above = 0;
    } else {
      this.cur.push(frame);
      if(rms > thr) this.voiced++;
      if(rms < thr * 0.8) this.below++; else this.below = 0;
      if(this.below >= this.HANG || this.cur.length >= this.MAX) this._end();
    }
    return rms;
  }
  _end(){
    let frames = this.cur;
    const drop = Math.max(0, this.below - this.KEEP_TAIL);
    if(drop) frames = frames.slice(0, frames.length - drop);
    this.speaking = false; this.cur = []; this.above = 0; this.below = 0;
    this.cb.onEnd?.();
    // Drops clicks, coughs and distant chatter that Whisper would otherwise hallucinate on.
    if(frames.length < this.MIN || this.voiced < this.MIN_VOICED) return;
    const pcm = new Float32Array(frames.length * FRAME);
    frames.forEach((f, i) => pcm.set(f, i * FRAME));
    const start = this.segStart;
    this.cb.onSegment?.({ pcm, start, end: start + pcm.length / TARGET_RATE });
  }
  flush(){ if(this.speaking) this._end(); }
}

function offlineSegments(pcm, sensitivity){
  const segs = [];
  const vad = new VAD(sensitivity, { onSegment: s => segs.push(s) });
  for(let i = 0; i + FRAME <= pcm.length; i += FRAME) vad.process(pcm.subarray(i, i + FRAME));
  vad.flush();
  if(!segs.length && pcm.length > TARGET_RATE * 0.3){
    const step = TARGET_RATE * 25;
    for(let i = 0; i < pcm.length; i += step){
      const chunk = pcm.slice(i, Math.min(pcm.length, i + step));
      segs.push({ pcm: chunk, start: i / TARGET_RATE, end: (i + chunk.length) / TARGET_RATE });
    }
  }
  return segs;
}

/* =========================================================
   Engines
   emit: interim(text, system), final({text, confidence, start, end, alternatives}),
         status(text, state), log(msg, level), error(msg, fatal), progress(p, text)
   Timestamps passed to final() are relative to the engine's own audio start.
========================================================= */
class Engine{
  constructor(opts, env){ this.opts = opts; this.env = env; }
  get usesVAD(){ return false; }
  async start(){}
  async stop(){}
  async transcribeFile(){ throw new Error('This engine cannot transcribe files.'); }
}

/* ---- Batch engines: transcribe VAD segments one at a time ---- */
class BatchEngine extends Engine{
  constructor(o, e){ super(o, e); this.queue = Promise.resolve(); this.pending = 0; }
  get usesVAD(){ return true; }
  async init(){}
  async start(){ await this.init(); }
  pushSegment(seg){
    this.pending++;
    this._showPending();
    this.queue = this.queue
      .then(() => this._run(seg))
      .catch(err => {
        const msg = err.message || String(err);
        this.env.emit.error(msg, /HTTP 40[13]|API key is required/.test(msg));
      })
      .finally(() => { this.pending--; this._showPending(); });
  }
  _showPending(){
    this.env.emit.interim(this.pending > 0 ? `Transcribing ${this.pending} segment${this.pending > 1 ? 's' : ''}…` : '', true);
  }
  async _run(seg){
    const r = await this.transcribe(seg.pcm);
    if(r && r.text && r.text.trim()) this.env.emit.final({ ...r, start: seg.start, end: seg.end });
  }
  async transcribeFile(pcm, onProgress){
    await this.init();
    const segs = offlineSegments(pcm, this.env.vadSensitivity);
    this.env.emit.log(`File split into ${segs.length} speech segment(s).`);
    for(let i = 0; i < segs.length; i++){
      onProgress(i / segs.length);
      await this._run(segs[i]);
    }
    onProgress(1);
  }
}

/* ---- Streaming engines: continuous 16-bit PCM over WebSocket ---- */
function openWebSocket(url, protocols, provider){
  return new Promise((resolve, reject) => {
    let ws;
    try{ ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url); }
    catch(e){ reject(new Error(`${provider}: ${e.message}`)); return; }
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => { try{ ws.close(); }catch{} reject(new Error(`${provider}: connection timed out.`)); }, 10000);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onclose = e => { clearTimeout(timer); reject(new Error(`${provider}: connection refused (${e.code}${e.reason ? ' ' + e.reason : ''}). Check API key, network or proxy.`)); };
  });
}
function waitClose(ws, ms){
  return new Promise(resolve => {
    if(!ws || ws.readyState === WebSocket.CLOSED) return resolve();
    const t = setTimeout(() => { try{ ws.close(); }catch{} resolve(); }, ms);
    ws.addEventListener('close', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

class StreamEngine extends Engine{
  get fileSpeed(){ return 1; }
  async start(pipeline){
    await this.open();
    this.acc = new Int16Array(STREAM_CHUNK); this.accN = 0;
    this.unsub = pipeline.onFrame(f => this._feed(f));
  }
  _feed(f){
    const s = floatToInt16(f);
    let off = 0;
    while(off < s.length){
      const n = Math.min(s.length - off, this.acc.length - this.accN);
      this.acc.set(s.subarray(off, off + n), this.accN);
      this.accN += n; off += n;
      if(this.accN === this.acc.length){ this.send(this.acc.slice().buffer); this.accN = 0; }
    }
  }
  async stop(){
    this.unsub?.();
    if(this.accN) this.send(this.acc.slice(0, this.accN).buffer);
    this.accN = 0;
    await this.close();
  }
  async transcribeFile(pcm, onProgress){
    await this.open();
    const s = floatToInt16(pcm);
    for(let i = 0; i < s.length; i += STREAM_CHUNK){
      if(!this.isOpen()) throw new Error('Connection closed during file upload.');
      this.send(s.slice(i, i + STREAM_CHUNK).buffer);
      onProgress(i / s.length);
      await sleep(100 / this.fileSpeed);
    }
    onProgress(1);
    await this.close();
  }
  send(buf){ if(this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf); }
  isOpen(){ return this.ws?.readyState === WebSocket.OPEN; }
  _watchClose(provider){
    this.ws.onclose = e => {
      if(!this.closing) this.env.emit.error(`${provider} connection closed (${e.code}${e.reason ? ': ' + e.reason : ''}).`, true);
    };
  }
}

/* ---- Chrome Web Speech API (cloud or on-device) ---- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
async function chromeOnDeviceStatus(lang){
  if(!SR) return 'unsupported';
  try{
    if(typeof SR.available === 'function') return await SR.available({ langs: [lang], processLocally: true });
    if(typeof SR.availableOnDevice === 'function') return await SR.availableOnDevice(lang);
  }catch(e){ log('On-device availability check failed: ' + e.message, 'warn'); }
  return 'unsupported';
}
async function chromeOnDeviceInstall(lang){
  if(typeof SR?.install === 'function') return SR.install({ langs: [lang], processLocally: true });
  if(typeof SR?.installOnDevice === 'function') return SR.installOnDevice(lang);
  throw new Error('On-device install API not available in this browser.');
}

class ChromeEngine extends Engine{
  constructor(o, e, local){ super(o, e); this.local = local; this.usePhrases = true; this.restartTimes = []; }
  async start(pipeline){
    if(!SR) throw new Error('Web Speech API not available. Use Chrome or Edge.');
    this.track = pipeline?.processedTrack || null;
    if(this.local){
      const st = await chromeOnDeviceStatus(this.env.lang);
      if(st === 'unsupported') throw new Error('On-device recognition not supported here (requires a recent Chrome desktop build).');
      if(st === 'downloadable' || st === 'downloading') throw new Error(`On-device pack for ${this.env.lang} is ${st}. Click "Check / install language pack" first.`);
      if(st === 'unavailable') throw new Error(`On-device recognition is unavailable for ${this.env.lang}.`);
    }
    this.active = true;
    this._spawn();
  }
  _spawn(){
    const r = new SR();
    this.r = r;
    r.lang = this.env.lang;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 5;
    if(this.local){
      if('processLocally' in r) r.processLocally = true;
      else if('mode' in r) r.mode = 'ondevice-only';
    }
    if(this.usePhrases && window.SpeechRecognitionPhrase && 'phrases' in r && this.env.vocabTerms.length){
      try{
        r.phrases = this.env.vocabTerms.slice(0, 100).map(t => new window.SpeechRecognitionPhrase(t, this.env.boost.chrome));
        if(!this.phrasesLogged){ this.env.emit.log(`Phrase biasing active (${Math.min(100, this.env.vocabTerms.length)} terms).`); this.phrasesLogged = true; }
      }
      catch(e){ this.usePhrases = false; this.env.emit.log('Phrase biasing not accepted: ' + e.message, 'warn'); }
    } else if(!this.phrasesLogged && this.env.vocabTerms.length){
      this.env.emit.log('Phrase biasing not available in this Chrome build; relying on post-correction only.', 'warn');
      this.phrasesLogged = true;
    }
    r.onstart = () => this.env.emit.status(this.local ? 'Listening — Chrome on-device' : 'Listening — Chrome cloud', 'live');
    r.onresult = ev => {
      let interim = '';
      for(let i = ev.resultIndex; i < ev.results.length; i++){
        const res = ev.results[i];
        if(res.isFinal){
          const alts = [];
          for(let k = 0; k < res.length; k++) alts.push({ text: res[k].transcript.trim(), confidence: res[k].confidence || null });
          const best = pickBestAlternative(alts, this.env.vocabTerms);
          this.env.emit.final({ text: best.text, confidence: best.confidence ?? alts[0].confidence, alternatives: alts });
        } else interim += res[0].transcript;
      }
      this.env.emit.interim(interim.trim());
    };
    r.onerror = e => {
      const err = e.error;
      if(err === 'no-speech' || err === 'aborted') return;
      if(err === 'phrases-not-supported'){ this.usePhrases = false; this.env.emit.log('Phrase biasing not supported; continuing without it.', 'warn'); return; }
      if(['not-allowed', 'service-not-allowed', 'language-not-supported', 'audio-capture'].includes(err)){
        this.active = false;
        this.env.emit.error('Recognition error: ' + err, true);
        return;
      }
      this.env.emit.log('Recognition error: ' + err + (e.message ? ' — ' + e.message : ''), 'warn');
    };
    r.onend = () => {
      if(!this.active) return;
      const now = Date.now();
      this.restartTimes = this.restartTimes.filter(t => now - t < 10000);
      this.restartTimes.push(now);
      if(this.restartTimes.length > 8){ this.active = false; this.env.emit.error('Recognizer keeps stopping (network or service issue).', true); return; }
      setTimeout(() => { if(this.active) this._spawn(); }, 250);
    };
    if(this.track && this.useTrack !== false){
      try{
        r.start(this.track);
        if(!this.trackLogged){ this.env.emit.log('Passing the selected mic (with app gain/noise settings) to Chrome recognizer; older Chrome builds ignore this and use the default mic.'); this.trackLogged = true; }
        return;
      }catch(e){
        this.useTrack = false;
        this.env.emit.log('This Chrome build cannot take a custom audio track; using its default mic.', 'warn');
      }
    }
    r.start();
  }
  async stop(){ this.active = false; try{ this.r?.stop(); }catch{} this.r = null; }
}

/* ---- Whisper via Transformers.js (in-browser) ---- */
const whisperCache = new Map();
const WHISPER_JUNK = /^(\[?blank_audio\]?|\(?silence\)?|\[music\]|thank you\.?|thanks for watching!?|you\.?|\.+)$/i;
class WhisperEngine extends BatchEngine{
  async init(){
    if(this.asr) return;
    const cdn = checkUrl(this.opts.cdn);
    let device = this.opts.device;
    if(device === 'auto'){
      const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
      device = adapter ? 'webgpu' : 'wasm';
    }
    const model = this.opts.model;
    const host = checkUrl(this.opts.host || 'https://huggingface.co/').replace(/\/?$/, '/');
    const localHost = new URL(host).origin === location.origin;
    const key = `${model}|${device}|${host}`;
    if(!whisperCache.has(key)){
      const files = new Map();
      const emit = this.env.emit;
      whisperCache.set(key, (async () => {
        const tf = await import(cdn);
        tf.env.allowLocalModels = localHost;
        tf.env.allowRemoteModels = !localHost;
        if(localHost) tf.env.localModelPath = host;
        else tf.env.remoteHost = host;
        return tf.pipeline('automatic-speech-recognition', model, {
          device,
          dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
          progress_callback: p => {
            if(p.status === 'progress' && p.total){
              files.set(p.file, [p.loaded, p.total]);
              let l = 0, t = 0;
              files.forEach(([a, b]) => { l += a; t += b; });
              emit.progress(l / t, `Downloading ${model} — ${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)} MB (cached after first load)`);
            }
          }
        });
      })().catch(e => {
        whisperCache.delete(key);
        const blocked = /fetch|network|tunnel|could not locate/i.test(e.message);
        throw new Error('Whisper load failed: ' + e.message + (blocked
          ? ` — ${new URL(host).hostname} may be blocked by your network proxy. Put the model in a local "models/" folder and set Model host to models/ (see serve.ps1).`
          : ''));
      }));
    }
    this.env.emit.status(`Loading Whisper (${device})…`, 'busy');
    this.env.emit.progress(-1, 'Preparing Whisper model…');
    try{ this.asr = await whisperCache.get(key); }
    finally{ this.env.emit.progress(null); }
    this.device = device;
    this.env.emit.log(`Whisper ready: ${model} on ${device.toUpperCase()}.`);
  }
  async transcribe(pcm){
    const out = await this.asr(pcm, { chunk_length_s: 30, stride_length_s: 5 });
    const text = String((Array.isArray(out) ? out[0]?.text : out?.text) || '').replace(/\[BLANK_AUDIO\]/gi, '').trim();
    if(!text || (WHISPER_JUNK.test(text) && pcm.length < TARGET_RATE * 3)) return null;
    return { text, confidence: null };
  }
}

/* ---- Hybrid: Chrome live preview + Whisper final per utterance ---- */
class HybridEngine extends WhisperEngine{
  _showPending(){
    if(!this.preview) super._showPending();
  }
  async _run(seg){
    await super._run(seg);
    if(this.preview && this.pending <= 1) this.env.emit.interim('', true);
  }
  async start(pipeline){
    await this.init();
    const env = this.env;
    const previewEnv = {
      ...env,
      emit: {
        ...env.emit,
        interim: t => { if(t) env.emit.interim(t); },
        final: r => env.emit.interim(r.text + '  (refining…)', true),
        status: () => {},
        error: m => env.emit.log('Live preview: ' + m, 'warn')
      }
    };
    this.preview = new ChromeEngine(this.opts, previewEnv, this.opts.preview !== 'cloud');
    try{ await this.preview.start(pipeline); }
    catch(e){ env.emit.log('Live preview unavailable (' + e.message + '); Whisper finals only.', 'warn'); this.preview = null; }
    env.emit.status(`Listening — Hybrid (Chrome preview + Whisper ${this.device})`, 'live');
  }
  async stop(){ await this.preview?.stop(); this.preview = null; }
}

/* ---- Vosk (offline Kaldi in WASM) ---- */
const voskModels = new Map();
class VoskEngine extends Engine{
  async _ensure(){
    await loadScript(checkUrl(this.opts.cdn));
    if(!window.Vosk) throw new Error('Vosk library failed to initialise.');
    const url = checkUrl(this.opts.modelUrl);
    if(!voskModels.has(url)){
      this.env.emit.status('Downloading Vosk model…', 'busy');
      this.env.emit.progress(-1, 'Downloading & unpacking Vosk model (first time only per session)…');
      voskModels.set(url, window.Vosk.createModel(url).catch(e => { voskModels.delete(url); throw new Error('Vosk model load failed: ' + (e?.message || e) + ' — if the model site is blocked by your proxy, download the .tar.gz into models/ and set Model URL to models/<file>.tar.gz.'); }));
    }
    try{ this.model = await voskModels.get(url); }
    finally{ this.env.emit.progress(null); }

    let grammar;
    if(this.opts.grammar && this.env.vocabTerms.length){
      const words = [...this.env.vocabTerms.map(t => t.toLowerCase()), ...Object.keys(NATO), ...Object.keys(DIGIT_WORDS),
        'flight', 'runway', 'left', 'right', 'center', 'decimal', 'thousand', 'hundred', '[unk]'];
      grammar = JSON.stringify([...new Set(words)]);
    }
    this.rec = grammar ? new this.model.KaldiRecognizer(TARGET_RATE, grammar) : new this.model.KaldiRecognizer(TARGET_RATE);
    this.rec.setWords(true);
    this.rec.on('result', m => {
      this._activity?.();
      const r = m.result;
      if(!r || !r.text) return;
      const words = r.result || [];
      this.env.emit.final({
        text: r.text,
        confidence: words.length ? avg(words.map(w => w.conf)) : null,
        start: words.length ? words[0].start : undefined,
        end: words.length ? words[words.length - 1].end : undefined
      });
      this.env.emit.interim('');
    });
    this.rec.on('partialresult', m => { this._activity?.(); const p = m.result?.partial; if(p) this.env.emit.interim(p); });
  }
  async start(pipeline){
    await this._ensure();
    this.unsub = pipeline.onFrame(f => { try{ this.rec?.acceptWaveformFloat(f, TARGET_RATE); }catch(e){ this.env.emit.error('Vosk: ' + e.message); } });
    this.env.emit.status('Listening — Vosk offline', 'live');
  }
  // Vosk's worker has no "done" signal, so wait until results go quiet (or maxMs elapses).
  async _finish(idleMs, maxMs){
    if(!this.rec) return;
    await new Promise(resolve => {
      let idle;
      this._activity = () => { clearTimeout(idle); idle = setTimeout(resolve, idleMs); };
      this._activity();
      setTimeout(resolve, maxMs);
      try{ this.rec.retrieveFinalResult(); }catch{}
    });
    this._activity = null;
    try{ this.rec.remove(); }catch{}
    this.rec = null;
  }
  async stop(){ this.unsub?.(); await this._finish(1200, 4000); }
  async transcribeFile(pcm, onProgress){
    await this._ensure();
    for(let i = 0; i < pcm.length; i += TARGET_RATE){
      this.rec.acceptWaveformFloat(pcm.slice(i, i + TARGET_RATE), TARGET_RATE);
      if((i / TARGET_RATE) % 10 === 0){ onProgress(i / pcm.length); await sleep(0); }
    }
    onProgress(1);
    await this._finish(3000, 15000 + pcm.length / TARGET_RATE * 500);
  }
}

/* ---- OpenAI (gpt-4o-transcribe / whisper-1, or any OpenAI-compatible server) ---- */
class OpenAIEngine extends BatchEngine{
  async init(){ requireKey(this.opts.apiKey, 'OpenAI'); checkUrl(this.opts.baseUrl, true); }
  async transcribe(pcm){
    const key = requireKey(this.opts.apiKey, 'OpenAI');
    const base = checkUrl(this.opts.baseUrl, true).replace(/\/+$/, '');
    const model = this.opts.model;
    const fd = new FormData();
    fd.append('file', encodeWAV(pcm), 'segment.wav');
    fd.append('model', model);
    const prompt = this.env.prompt();
    if(prompt) fd.append('prompt', prompt);
    fd.append('language', this.env.lang.split('-')[0]);
    if(model === 'whisper-1') fd.append('response_format', 'verbose_json');
    else { fd.append('response_format', 'json'); fd.append('include[]', 'logprobs'); }
    const res = await safeFetch(base + '/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd }, 'OpenAI');
    if(!res.ok) throw await httpError(res, 'OpenAI');
    const j = await res.json();
    let confidence = null;
    if(Array.isArray(j.segments) && j.segments.length) confidence = Math.exp(avg(j.segments.map(s => s.avg_logprob ?? 0)));
    else if(Array.isArray(j.logprobs) && j.logprobs.length) confidence = avg(j.logprobs.map(l => Math.exp(l.logprob)));
    return { text: String(j.text || '').trim(), confidence };
  }
}

/* ---- Google Cloud Speech-to-Text (REST, per segment) ---- */
class GoogleEngine extends BatchEngine{
  async init(){ requireKey(this.opts.apiKey, 'Google'); }
  async transcribe(pcm){
    const key = requireKey(this.opts.apiKey, 'Google');
    const terms = this.env.vocabTerms.filter(t => t.length <= 100).slice(0, 500);
    const config = {
      encoding: 'LINEAR16', sampleRateHertz: TARGET_RATE, languageCode: this.env.lang,
      enableAutomaticPunctuation: true, model: this.opts.model, maxAlternatives: 1
    };
    if(terms.length) config.speechContexts = [{ phrases: terms, boost: this.env.boost.google }];
    const body = { config, audio: { content: bytesToBase64(new Uint8Array(floatToInt16(pcm).buffer)) } };
    const res = await safeFetch(`https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(key)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'Google');
    if(!res.ok) throw await httpError(res, 'Google');
    const j = await res.json();
    const results = j.results || [];
    const text = results.map(r => r.alternatives?.[0]?.transcript || '').join(' ').trim();
    const confs = results.map(r => r.alternatives?.[0]?.confidence).filter(c => typeof c === 'number');
    return { text, confidence: avg(confs) };
  }
}

/* ---- Custom HTTP endpoint (whisper.cpp, faster-whisper, own backend) ---- */
class CustomEngine extends BatchEngine{
  async init(){ checkUrl(this.opts.url, true); parseJSONField(this.opts.headers, 'Headers'); parseJSONField(this.opts.fields, 'Extra fields'); }
  async transcribe(pcm){
    const url = checkUrl(this.opts.url, true);
    const headers = parseJSONField(this.opts.headers, 'Headers');
    const extra = parseJSONField(this.opts.fields, 'Extra fields');
    const wav = encodeWAV(pcm);
    let body;
    if(this.opts.format === 'multipart'){
      body = new FormData();
      body.append(this.opts.fileField || 'file', wav, 'segment.wav');
      for(const [k, v] of Object.entries(extra)) body.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    } else {
      body = wav;
      if(!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'audio/wav';
    }
    const res = await safeFetch(url, { method: 'POST', headers, body }, 'Custom endpoint');
    if(!res.ok) throw await httpError(res, 'Custom endpoint');
    const ct = res.headers.get('content-type') || '';
    if(ct.includes('json')){
      const j = await res.json();
      const text = getPath(j, this.opts.path || 'text');
      const c = getPath(j, this.opts.confPath);
      return { text: String(text ?? '').trim(), confidence: typeof c === 'number' ? c : null };
    }
    return { text: (await res.text()).trim(), confidence: null };
  }
}

/* ---- Deepgram real-time ---- */
class DeepgramEngine extends StreamEngine{
  get fileSpeed(){ return 4; }
  async open(){
    const key = requireKey(this.opts.apiKey, 'Deepgram');
    const model = this.opts.model;
    const p = new URLSearchParams({
      model, encoding: 'linear16', sample_rate: String(TARGET_RATE), channels: '1',
      interim_results: 'true', smart_format: 'true', punctuate: 'true',
      utterance_end_ms: '1000', vad_events: 'true', endpointing: '300', language: this.env.lang
    });
    const terms = this.env.vocabTerms.slice(0, 50);
    if(model.startsWith('nova-3')) terms.forEach(t => p.append('keyterm', t));
    else terms.filter(t => !/\s/.test(t)).forEach(t => p.append('keywords', `${t}:${this.env.boost.deepgram}`));
    this.buf = []; this.confs = []; this.bufStart = null; this.bufEnd = null; this.closing = false;
    this.ws = await openWebSocket(`wss://api.deepgram.com/v1/listen?${p}`, ['token', key], 'Deepgram');
    this._watchClose('Deepgram');
    this.ws.onmessage = e => this._msg(e.data);
    this.keepAlive = setInterval(() => { if(this.isOpen()) this.ws.send(JSON.stringify({ type: 'KeepAlive' })); }, 5000);
    this.env.emit.status('Listening — Deepgram ' + model, 'live');
  }
  _msg(data){
    if(typeof data !== 'string') return;
    let j; try{ j = JSON.parse(data); }catch{ return; }
    if(j.type === 'Results'){
      const alt = j.channel?.alternatives?.[0];
      const text = alt?.transcript || '';
      if(j.is_final){
        if(text){
          if(this.bufStart === null) this.bufStart = j.start;
          this.buf.push(text);
          this.confs.push(alt.confidence);
          this.bufEnd = j.start + j.duration;
        }
        if(j.speech_final) this._flush();
        else this.env.emit.interim(this.buf.join(' '));
      } else this.env.emit.interim([...this.buf, text].join(' ').trim());
    } else if(j.type === 'UtteranceEnd') this._flush();
    else if(j.type === 'Error' || j.err_msg) this.env.emit.error('Deepgram: ' + (j.description || j.err_msg || j.message));
  }
  _flush(){
    if(!this.buf.length) return;
    this.env.emit.final({ text: this.buf.join(' '), confidence: avg(this.confs), start: this.bufStart, end: this.bufEnd });
    this.buf = []; this.confs = []; this.bufStart = null;
    this.env.emit.interim('');
  }
  async close(){
    clearInterval(this.keepAlive);
    if(!this.ws) return;
    this.closing = true;
    if(this.isOpen()) this.ws.send(JSON.stringify({ type: 'CloseStream' }));
    await waitClose(this.ws, 4000);
    this._flush();
    this.ws = null;
  }
}

/* ---- AssemblyAI Universal-Streaming (v3) ---- */
class AssemblyAIEngine extends StreamEngine{
  async open(){
    let token = String(this.opts.token || '').trim();
    if(!token){
      const key = requireKey(this.opts.apiKey, 'AssemblyAI');
      const res = await safeFetch('https://streaming.assemblyai.com/v3/token?expires_in_seconds=600',
        { headers: { Authorization: key } }, 'AssemblyAI token (if blocked by CORS, paste a server-generated temporary token)');
      if(!res.ok) throw await httpError(res, 'AssemblyAI token');
      token = (await res.json()).token;
    }
    if(!this.env.lang.startsWith('en')) this.env.emit.log('AssemblyAI streaming model is English-only.', 'warn');
    const p = new URLSearchParams({ sample_rate: String(TARGET_RATE), encoding: 'pcm_s16le', format_turns: 'true', token });
    const terms = this.env.vocabTerms.slice(0, 100);
    if(terms.length) p.set('keyterms_prompt', JSON.stringify(terms));
    this.closing = false;
    this.ws = await openWebSocket(`wss://streaming.assemblyai.com/v3/ws?${p}`, null, 'AssemblyAI');
    this._watchClose('AssemblyAI');
    this.ws.onmessage = e => this._msg(e.data);
    this.env.emit.status('Listening — AssemblyAI streaming', 'live');
  }
  _msg(data){
    if(typeof data !== 'string') return;
    let j; try{ j = JSON.parse(data); }catch{ return; }
    if(j.type === 'Turn'){
      if(j.end_of_turn && j.turn_is_formatted){
        const w = j.words || [];
        this.env.emit.final({
          text: j.transcript,
          confidence: w.length ? avg(w.map(x => x.confidence)) : null,
          start: w.length ? w[0].start / 1000 : undefined,
          end: w.length ? w[w.length - 1].end / 1000 : undefined
        });
        this.env.emit.interim('');
      } else if(!j.end_of_turn) this.env.emit.interim(j.transcript || '');
    } else if(j.type === 'Begin') this.env.emit.log('AssemblyAI session started.');
    else if(j.error) this.env.emit.error('AssemblyAI: ' + j.error);
  }
  async close(){
    if(!this.ws) return;
    this.closing = true;
    if(this.isOpen()) this.ws.send(JSON.stringify({ type: 'Terminate' }));
    await waitClose(this.ws, 4000);
    this.ws = null;
  }
}

/* ---- Registry ---- */
const whisperFields = defModel => [
  { key: 'model', type: 'select', label: 'Model', default: defModel, options: [
    ['onnx-community/whisper-tiny.en', 'tiny.en — ~40 MB, fastest'],
    ['onnx-community/whisper-base.en', 'base.en — ~80 MB, balanced'],
    ['onnx-community/whisper-small.en', 'small.en — ~250 MB, most accurate'],
    ['onnx-community/whisper-base', 'base — multilingual']] },
  { key: 'device', type: 'select', label: 'Compute', default: 'auto', options: [['auto', 'Auto (WebGPU if available)'], ['webgpu', 'WebGPU'], ['wasm', 'WASM (CPU)']] },
  { key: 'host', type: 'text', label: 'Model host (URL, or models/ for a local copy)', default: 'https://huggingface.co/' },
  { key: 'cdn', type: 'text', label: 'Transformers.js module URL', default: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3' }
];
const ENGINES = [
  { id: 'hybrid', group: 'Hybrid (recommended)', name: 'Hybrid — Chrome live preview + Whisper final', privacy: 'private', file: true,
    info: 'Instant words from Chrome while you talk, then each utterance is re-transcribed by local Whisper for accuracy. Private with on-device preview.',
    fields: [
      { key: 'preview', type: 'select', label: 'Live preview', default: 'local', options: [['local', 'Chrome on-device (private)'], ['cloud', 'Chrome cloud']] },
      ...whisperFields('onnx-community/whisper-small.en'),
      { type: 'action', label: 'Check / install Chrome language pack', run: checkInstallOnDevice }],
    create: (o, e) => new HybridEngine(o, e) },
  { id: 'chrome', group: 'Browser', name: 'Chrome Speech (cloud, streaming)', privacy: 'cloud', file: false,
    info: 'Fast streaming via Google servers. Uses up to 5 alternatives re-ranked with your aviation vocabulary.',
    fields: [], create: (o, e) => new ChromeEngine(o, e, false) },
  { id: 'chrome-local', group: 'Browser', name: 'Chrome On-Device (private, offline)', privacy: 'private', file: false,
    info: 'Runs inside Chrome — audio never leaves the device. Install the language pack once. Supports phrase biasing.',
    fields: [{ type: 'action', label: 'Check / install language pack', run: checkInstallOnDevice }],
    create: (o, e) => new ChromeEngine(o, e, true) },
  { id: 'whisper', group: 'Local (in-browser)', name: 'Whisper — Transformers.js (WebGPU/WASM)', privacy: 'private', file: true,
    info: 'OpenAI Whisper running locally on your GPU (WebGPU) or CPU (WASM). Model is cached after first download.',
    fields: whisperFields('onnx-community/whisper-base.en'),
    create: (o, e) => new WhisperEngine(o, e) },
  { id: 'vosk', group: 'Local (in-browser)', name: 'Vosk — offline streaming (Kaldi WASM)', privacy: 'private', file: true,
    info: 'Lightweight fully offline streaming recognizer. Optional grammar mode restricts output to aviation vocabulary.',
    fields: [
      { key: 'modelUrl', type: 'text', label: 'Model URL (.tar.gz)', default: 'https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-en-us-0.15.tar.gz' },
      { key: 'grammar', type: 'checkbox', label: 'Restrict to vocabulary grammar', default: false },
      { key: 'cdn', type: 'text', label: 'vosk-browser script URL', default: 'https://cdn.jsdelivr.net/npm/vosk-browser@0.0.8/dist/vosk.js' }],
    create: (o, e) => new VoskEngine(o, e) },
  { id: 'openai', group: 'Cloud', name: 'OpenAI — gpt-4o-transcribe / Whisper', privacy: 'cloud', file: true,
    info: 'High accuracy. Segments are sent per utterance with your vocabulary and recent context as a prompt.',
    fields: [
      { key: 'apiKey', type: 'password', label: 'API key', secret: true, placeholder: 'sk-…' },
      { key: 'model', type: 'select', label: 'Model', default: 'gpt-4o-transcribe', options: [
        ['gpt-4o-transcribe', 'gpt-4o-transcribe (best)'], ['gpt-4o-mini-transcribe', 'gpt-4o-mini-transcribe (cheaper)'], ['whisper-1', 'whisper-1']] },
      { key: 'baseUrl', type: 'text', label: 'Base URL (OpenAI-compatible)', default: 'https://api.openai.com/v1' }],
    create: (o, e) => new OpenAIEngine(o, e) },
  { id: 'deepgram', group: 'Cloud', name: 'Deepgram — real-time streaming', privacy: 'cloud', file: true,
    info: 'Low-latency streaming with keyterm boosting. nova-2-atc is tuned for air-traffic-control audio.',
    fields: [
      { key: 'apiKey', type: 'password', label: 'API key', secret: true },
      { key: 'model', type: 'select', label: 'Model', default: 'nova-3', options: [['nova-3', 'nova-3 (keyterm prompting)'], ['nova-2-atc', 'nova-2-atc (air traffic control)'], ['nova-2', 'nova-2']] }],
    create: (o, e) => new DeepgramEngine(o, e) },
  { id: 'assemblyai', group: 'Cloud', name: 'AssemblyAI — Universal-Streaming', privacy: 'cloud', file: true,
    info: 'Streaming with smart turn detection and keyterm prompting. If token fetch is blocked by CORS, paste a temporary token.',
    fields: [
      { key: 'apiKey', type: 'password', label: 'API key', secret: true },
      { key: 'token', type: 'password', label: 'Temporary token (optional)', secret: true }],
    create: (o, e) => new AssemblyAIEngine(o, e) },
  { id: 'google', group: 'Cloud', name: 'Google Cloud Speech-to-Text', privacy: 'cloud', file: true,
    info: 'Per-utterance recognition with speech-context phrase boosting.',
    fields: [
      { key: 'apiKey', type: 'password', label: 'API key', secret: true },
      { key: 'model', type: 'select', label: 'Model', default: 'latest_short', options: [
        ['latest_short', 'latest_short (commands, short phrases)'], ['latest_long', 'latest_long'], ['phone_call', 'phone_call (radio / narrowband)'], ['command_and_search', 'command_and_search'], ['default', 'default']] }],
    create: (o, e) => new GoogleEngine(o, e) },
  { id: 'custom', group: 'Custom', name: 'Custom HTTP endpoint (whisper.cpp, faster-whisper…)', privacy: 'custom', file: true,
    info: 'POSTs each utterance as WAV to your own server. Example: whisper.cpp server at http://127.0.0.1:8080/inference.',
    fields: [
      { key: 'url', type: 'text', label: 'Endpoint URL', default: 'http://127.0.0.1:8080/inference' },
      { key: 'format', type: 'select', label: 'Body format', default: 'multipart', options: [['multipart', 'multipart/form-data'], ['wav', 'raw audio/wav']] },
      { key: 'fileField', type: 'text', label: 'File field name', default: 'file' },
      { key: 'fields', type: 'textarea', label: 'Extra form fields (JSON)', default: '{"response_format":"json"}' },
      { key: 'headers', type: 'textarea', label: 'Headers (JSON)', default: '{}', secret: true },
      { key: 'path', type: 'text', label: 'Response text path', default: 'text' },
      { key: 'confPath', type: 'text', label: 'Response confidence path (optional)', default: '' }],
    create: (o, e) => new CustomEngine(o, e) }
];
const engineDef = id => ENGINES.find(e => e.id === id) || ENGINES[0];

/* =========================================================
   Settings persistence
========================================================= */
const DEFAULT_SETTINGS = {
  engine: 'chrome', lang: 'en-US', strict: false, autoAccept: true, threshold: 85, vadSens: 6,
  deviceId: '', gain: 1, ns: true, ec: true, agc: true,
  boost: 'off', gate: 0, ptt: false,
  theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  vocab: DEFAULT_VOCAB, rememberKeys: false, engineOpts: {}
};
function readJSON(key, fallback){
  try{ const v = JSON.parse(localStorage.getItem(key) || 'null'); return v ?? fallback; }catch{ return fallback; }
}
const settings = { ...DEFAULT_SETTINGS, ...readJSON(LS_SETTINGS, {}) };
const secrets = readJSON(LS_KEYS, {});
function saveSettings(){
  try{
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
    if(settings.rememberKeys) localStorage.setItem(LS_KEYS, JSON.stringify(secrets));
    else localStorage.removeItem(LS_KEYS);
  }catch(e){ log('Could not save settings: ' + e.message, 'warn'); }
}
function getEngineOpts(id){
  const def = engineDef(id);
  const opts = {};
  for(const f of def.fields){
    if(!f.key) continue;
    const store = f.secret ? secrets : settings.engineOpts;
    const v = store[id]?.[f.key];
    opts[f.key] = v !== undefined ? v : (f.default ?? '');
  }
  return opts;
}
function setEngineOpt(id, field, value){
  const store = field.secret ? secrets : settings.engineOpts;
  (store[id] ||= {})[field.key] = value;
  saveSettings();
}

let vocabCache = null;
const vocab = () => (vocabCache ||= parseVocab(settings.vocab));
const cleanOpts = () => ({ strict: settings.strict, vocab: vocab() });

/* =========================================================
   Session state
========================================================= */
const state = {
  running: false, busy: false, stopping: false,
  engine: null, pipeline: null, vad: null, unsubVad: null,
  sessionId: null, sessionCreated: null, sessionStart: 0, captureOffset: 0,
  engineName: '', segments: [], pending: [], utterStart: null, editing: false
};
const now = () => (performance.now() - state.sessionStart) / 1000;

function newSession(keepClock = false){
  state.sessionId = uid();
  state.sessionCreated = new Date().toISOString();
  if(!keepClock) state.sessionStart = performance.now();
}

// A bare word list in a Whisper prompt makes it insert those words, so it's only added on "strong".
function buildPrompt(){
  if(settings.boost === 'off') return '';
  const recent = state.segments.filter(s => s.text && s.status !== 'rejected').slice(-2).map(s => s.text).join(' ').slice(-150);
  const terms = settings.boost === 'strong' ? ' Terms that may appear: ' + vocab().terms.slice(0, 40).join(', ') + '.' : '';
  return `Airline operations conversation.${terms}${recent ? ' ' + recent : ''}`.slice(0, 900);
}

const BOOST = {
  off: { terms: 0, chrome: 0, google: 0, deepgram: 0 },
  light: { terms: 25, chrome: 1.5, google: 5, deepgram: 1 },
  strong: { terms: 100, chrome: 5, google: 15, deepgram: 2 }
};
function makeEnv(){
  const boost = BOOST[settings.boost] || BOOST.off;
  return {
    lang: settings.lang,
    vocabTerms: vocab().terms.slice(0, boost.terms),
    boost,
    vadSensitivity: settings.vadSens,
    prompt: buildPrompt,
    emit: {
      interim: onInterim,
      final: onFinal,
      status: (t, s) => setStatus(t, s),
      log: (m, l) => log(m, l),
      error: onEngineError,
      progress: showProgress
    }
  };
}

/* =========================================================
   Results handling
========================================================= */
const interimEl = $('interim'), confidenceEl = $('confidence'), activeModeEl = $('activeMode');

function onInterim(text, system){
  interimEl.textContent = text || '';
  if(text && !system && state.utterStart === null) state.utterStart = now();
}

function confClass(c){ return c === null || c === undefined ? 'na' : c >= 0.85 ? 'high' : c >= 0.65 ? 'mid' : 'low'; }
function confText(c){ return c === null || c === undefined ? '—' : Math.round(c * 100) + '%'; }

function onFinal(r){
  const raw = String(r.text || '').replace(/\s+/g, ' ').trim();
  if(!raw) return;
  const clean = cleanTranscript(raw, cleanOpts());
  const t = now();
  const start = r.start !== undefined && r.start !== null ? r.start + state.captureOffset : (state.utterStart ?? Math.max(0, t - 2));
  const end = r.end !== undefined && r.end !== null ? r.end + state.captureOffset : Math.max(start + 0.5, t);
  state.utterStart = null;

  const conf = typeof r.confidence === 'number' && isFinite(r.confidence) ? Math.max(0, Math.min(1, r.confidence)) : null;
  const seg = {
    id: uid(), start, end, raw, clean, text: null, confidence: conf,
    engine: state.engineName, status: 'pending', emergency: EMERGENCY.test(clean)
  };
  state.segments.push(seg);
  confidenceEl.textContent = confText(conf);
  if(seg.emergency){ flashAlert('Emergency phrase detected: ' + clean); log('EMERGENCY phrase detected: ' + clean, 'error'); }
  log(`Final (${confText(conf)}): ${raw}`);

  if(raw === clean) acceptSegment(seg, clean, 'auto');
  else if(settings.autoAccept && conf !== null && conf * 100 >= settings.threshold){
    acceptSegment(seg, clean, 'auto');
    log('Auto-accepted correction: ' + clean);
  } else {
    state.pending.push(seg);
    renderPreview();
  }
  renderSegments();
}

function acceptSegment(seg, text, status){
  seg.text = text; seg.status = status;
  state.pending = state.pending.filter(s => s !== seg);
  renderTranscript();
  scheduleSaveSession();
}

function onEngineError(msg, fatal){
  log(msg, 'error');
  if(fatal && state.running){
    stopSession(true).then(() => setStatus('Error: ' + msg, 'error'));
  }
}

/* =========================================================
   Preview (raw vs corrected)
========================================================= */
const previewArea = $('previewArea'), rawTextEl = $('rawText'), cleanTextEl = $('cleanText'), editText = $('editText');
function renderPreview(){
  const seg = state.pending[0];
  $('pendingCount').textContent = state.pending.length ? `${state.pending.length} awaiting review` : '';
  if(!seg){ previewArea.hidden = true; setEditing(false); return; }
  previewArea.hidden = false;
  rawTextEl.textContent = seg.raw;
  renderDiff(cleanTextEl, seg.raw, seg.clean);
  if(!state.editing) editText.value = seg.clean;
}
function setEditing(on){
  state.editing = on;
  editText.hidden = !on;
  cleanTextEl.hidden = on;
  $('editBtn').textContent = on ? 'Cancel edit' : 'Edit';
  if(on){ editText.value = state.pending[0]?.clean || ''; editText.focus(); }
}
function acceptCurrent(){
  const seg = state.pending[0];
  if(!seg) return;
  const edited = state.editing ? editText.value.trim() : '';
  if(edited && edited !== seg.clean){ acceptSegment(seg, edited, 'edited'); log('Accepted edited text: ' + edited); }
  else { acceptSegment(seg, seg.clean, 'accepted'); log('Accepted correction: ' + seg.clean); }
  setEditing(false);
  renderPreview(); renderSegments();
}
function rejectCurrent(){
  const seg = state.pending[0];
  if(!seg) return;
  acceptSegment(seg, seg.raw, 'rejected');
  log('Rejected correction, used raw: ' + seg.raw);
  setEditing(false);
  renderPreview(); renderSegments();
}

/* =========================================================
   Segment list, transcript, export
========================================================= */
const segList = $('segments');
function renderSegments(){
  const items = state.segments.map(seg => {
    const li = document.createElement('li');
    li.className = seg.status + (seg.emergency ? ' emergency' : '');

    const time = document.createElement('span');
    time.className = 'time'; time.textContent = fmtClock(seg.start);

    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = seg.text ?? seg.clean;
    if(seg.status !== 'pending'){
      try{ text.contentEditable = 'plaintext-only'; }catch{ text.contentEditable = 'true'; }
      text.spellcheck = false;
      text.title = 'Click to edit';
      text.addEventListener('blur', () => {
        const v = text.textContent.replace(/\s+/g, ' ').trim();
        if(v && v !== seg.text){ seg.text = v; seg.status = 'edited'; renderTranscript(); scheduleSaveSession(); }
        else text.textContent = seg.text;
      });
      text.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); text.blur(); } });
    }

    const conf = document.createElement('span');
    conf.className = 'conf ' + confClass(seg.confidence);
    conf.textContent = confText(seg.confidence);
    conf.title = 'Confidence';

    const eng = document.createElement('span');
    eng.className = 'eng'; eng.textContent = seg.status === 'pending' ? 'review' : seg.status;

    const del = document.createElement('button');
    del.className = 'del'; del.textContent = '×'; del.title = 'Delete segment'; del.setAttribute('aria-label', 'Delete segment');
    del.addEventListener('click', () => {
      state.segments = state.segments.filter(s => s !== seg);
      state.pending = state.pending.filter(s => s !== seg);
      renderSegments(); renderPreview(); renderTranscript(); scheduleSaveSession();
    });

    li.append(time, conf, text, eng, del);
    li.title = `${seg.engine} • ${fmtClock(seg.start)}–${fmtClock(seg.end)}\nRaw: ${seg.raw}`;
    return li;
  });
  segList.replaceChildren(...items);
  segList.scrollTop = segList.scrollHeight;
  const acc = acceptedSegments().length;
  $('segCount').textContent = state.segments.length ? `(${acc} accepted${state.pending.length ? `, ${state.pending.length} pending` : ''})` : '';
}
const acceptedSegments = () => state.segments.filter(s => s.status !== 'pending' && s.text).slice().sort((a, b) => a.start - b.start);
function renderTranscript(){ $('transcript').value = acceptedSegments().map(s => s.text).join('\n'); }

function download(content, type, ext){
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `webtok-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${ext}`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function exportAs(fmt){
  const segs = acceptedSegments();
  if(!segs.length){ log('Nothing to export yet.', 'warn'); return; }
  if(fmt === 'txt') download(segs.map(s => `[${fmtClock(s.start)}] ${s.text}`).join('\n') + '\n', 'text/plain', 'txt');
  else if(fmt === 'json') download(JSON.stringify({
    app: 'WebTok STT', session: state.sessionId, created: state.sessionCreated, exported: new Date().toISOString(), language: settings.lang,
    segments: segs.map(({ start, end, raw, clean, text, confidence, engine, status, emergency }) =>
      ({ start: +start.toFixed(2), end: +end.toFixed(2), text, raw, clean, confidence, engine, status, emergency }))
  }, null, 2), 'application/json', 'json');
  else if(fmt === 'srt') download(segs.map((s, i) =>
    `${i + 1}\n${srtTime(s.start)} --> ${srtTime(Math.max(s.end, s.start + 0.8))}\n${s.text}\n`).join('\n'), 'application/x-subrip', 'srt');
  log('Exported ' + fmt.toUpperCase() + '.');
}
async function copyTranscript(){
  const text = acceptedSegments().map(s => s.text).join('\n');
  if(!text){ log('Nothing to copy yet.', 'warn'); return; }
  try{ await navigator.clipboard.writeText(text); log('Transcript copied to clipboard.'); }
  catch{ const ta = $('transcript'); ta.closest('details').open = true; ta.select(); document.execCommand('copy'); log('Transcript copied.'); }
}

/* =========================================================
   History (localStorage)
========================================================= */
const loadHistory = () => { const h = readJSON(LS_HISTORY, []); return Array.isArray(h) ? h : []; };
let saveTimer = null;
function scheduleSaveSession(){ clearTimeout(saveTimer); saveTimer = setTimeout(saveSession, 800); }
function saveSession(){
  clearTimeout(saveTimer);
  const segs = state.segments.filter(s => s.status !== 'pending');
  if(!state.sessionId || !segs.length) return;
  const hist = loadHistory().filter(h => h.id !== state.sessionId);
  hist.unshift({
    id: state.sessionId, created: state.sessionCreated, updated: new Date().toISOString(),
    engines: [...new Set(segs.map(s => s.engine))],
    segments: segs.map(({ id, start, end, raw, clean, text, confidence, engine, status, emergency }) =>
      ({ id, start, end, raw, clean, text, confidence, engine, status, emergency }))
  });
  try{ localStorage.setItem(LS_HISTORY, JSON.stringify(hist.slice(0, MAX_HISTORY))); }
  catch{ log('History storage is full; delete old sessions.', 'warn'); }
  renderHistory();
}
function renderHistory(){
  const ul = $('history');
  const hist = loadHistory();
  if(!hist.length){
    const li = document.createElement('li'); li.className = 'small'; li.textContent = 'No saved sessions yet.';
    ul.replaceChildren(li); return;
  }
  ul.replaceChildren(...hist.map(h => {
    const li = document.createElement('li');
    const info = document.createElement('div'); info.className = 'info';
    const title = document.createElement('div');
    title.textContent = `${new Date(h.created).toLocaleString()} • ${h.segments.length} seg • ${(h.engines || []).join(', ')}`;
    const prev = document.createElement('div'); prev.className = 'small';
    prev.textContent = h.segments.map(s => s.text).join(' ').slice(0, 120);
    info.append(title, prev);
    const load = document.createElement('button'); load.className = 'ghost'; load.textContent = 'Load';
    load.addEventListener('click', () => loadSession(h));
    const del = document.createElement('button'); del.className = 'ghost'; del.textContent = 'Delete';
    del.addEventListener('click', () => {
      localStorage.setItem(LS_HISTORY, JSON.stringify(loadHistory().filter(x => x.id !== h.id)));
      renderHistory();
    });
    if(h.id === state.sessionId) li.style.fontWeight = '600';
    li.append(info, load, del);
    return li;
  }));
}
function loadSession(h){
  if(state.running || state.busy){ log('Stop the current session before loading history.', 'warn'); return; }
  saveSession();
  state.sessionId = h.id;
  state.sessionCreated = h.created;
  state.segments = h.segments.map(s => ({ ...s }));
  state.pending = [];
  const lastEnd = state.segments.reduce((m, s) => Math.max(m, s.end || 0), 0);
  state.sessionStart = performance.now() - (lastEnd + 1) * 1000;
  renderSegments(); renderPreview(); renderTranscript(); renderHistory();
  log(`Loaded session from ${new Date(h.created).toLocaleString()}.`);
}

/* =========================================================
   Visuals
========================================================= */
const canvas = $('wave'), ctx2d = canvas.getContext('2d'), meterFill = $('meter-fill');
let rafId = null, waveData = null, colors = {};
function readColors(){
  const cs = getComputedStyle(document.documentElement);
  colors = { bg: cs.getPropertyValue('--canvas').trim(), line: cs.getPropertyValue('--accent').trim(), grid: cs.getPropertyValue('--border').trim() };
}
function sizeCanvas(){
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, canvas.clientWidth * dpr);
  canvas.height = Math.max(1, canvas.clientHeight * dpr);
  if(!rafId) drawIdle();
}
function drawIdle(){
  ctx2d.fillStyle = colors.bg; ctx2d.fillRect(0, 0, canvas.width, canvas.height);
  ctx2d.strokeStyle = colors.grid; ctx2d.lineWidth = 1;
  ctx2d.beginPath(); ctx2d.moveTo(0, canvas.height / 2); ctx2d.lineTo(canvas.width, canvas.height / 2); ctx2d.stroke();
}
function startVisuals(analyser){
  waveData = new Uint8Array(analyser.fftSize);
  const draw = () => {
    rafId = requestAnimationFrame(draw);
    analyser.getByteTimeDomainData(waveData);
    const w = canvas.width, h = canvas.height;
    ctx2d.fillStyle = colors.bg; ctx2d.fillRect(0, 0, w, h);
    ctx2d.lineWidth = 2 * (window.devicePixelRatio || 1);
    ctx2d.strokeStyle = colors.line;
    ctx2d.beginPath();
    const slice = w / waveData.length;
    let sum = 0;
    for(let i = 0; i < waveData.length; i++){
      const v = waveData[i] / 128;
      const y = v * h / 2;
      if(i === 0) ctx2d.moveTo(0, y); else ctx2d.lineTo(i * slice, y);
      const n = v - 1; sum += n * n;
    }
    ctx2d.stroke();
    const rms = Math.sqrt(sum / waveData.length);
    meterFill.style.height = Math.min(100, rms * 400) + '%';
  };
  draw();
}
function stopVisuals(){
  if(rafId) cancelAnimationFrame(rafId);
  rafId = null;
  meterFill.style.height = '0%';
  drawIdle();
}

/* =========================================================
   Session orchestration
========================================================= */
const startBtn = $('startBtn'), stopBtn = $('stopBtn'), clearBtn = $('clearBtn'), fileInput = $('fileInput'), fileLabel = $('fileLabel');
const vadIndicator = $('vadIndicator');
function setControls(){
  const locked = state.running || state.busy;
  startBtn.disabled = locked;
  stopBtn.disabled = !state.running || state.stopping;
  fileInput.disabled = locked;
  fileLabel.classList.toggle('disabled', locked);
  for(const el of [$('engineSelect'), $('langSelect'), $('micSelect')]) el.disabled = locked;
  $('engineFields').querySelectorAll('input,select,textarea,button').forEach(el => { el.disabled = locked; });
}

async function startSession(){
  if(state.running || state.busy) return;
  const def = engineDef(settings.engine);
  state.busy = true; setControls();
  try{
    if(!state.sessionId) newSession();
    state.engineName = def.name;
    const engine = def.create(getEngineOpts(def.id), makeEnv());
    const pipeline = new AudioPipeline();
    setStatus('Requesting microphone…', 'busy');
    await pipeline.start({ deviceId: settings.deviceId, noiseSuppression: settings.ns, echoCancellation: settings.ec, autoGainControl: settings.agc, gain: settings.gain });
    state.pipeline = pipeline;
    pipeline.setGate(gateLevel(settings.gate), settings.ptt);
    pipeline.setTalk(!!state.talking);
    pipeline.onGate = open => { vadIndicator.textContent = open ? 'VOICE' : 'MUTED'; };
    vadIndicator.textContent = settings.ptt ? 'MUTED' : 'VOICE';
    startVisuals(pipeline.analyser);
    refreshDevices();

    state.captureOffset = now();
    const vad = new VAD(settings.vadSens, {
      onStart: t => { vadIndicator.classList.add('on'); if(engine.usesVAD) state.utterStart = state.captureOffset + t; },
      onEnd: () => vadIndicator.classList.remove('on'),
      onSegment: seg => { if(engine.usesVAD) engine.pushSegment(seg); }
    });
    state.vad = vad;
    state.unsubVad = pipeline.onFrame(f => vad.process(f));
    state.engine = engine;
    state.running = true;
    setStatus(`Starting ${def.name}…`, 'busy');
    await engine.start(pipeline);
    if(statusPill.dataset.state === 'busy') setStatus('Listening — ' + def.name, 'live');
    activeModeEl.textContent = def.name;
    log(`Session started: ${def.name}${pipeline.label ? ' • ' + pipeline.label : ''}.`);
  }catch(err){
    log('Start failed: ' + err.message, 'error');
    await stopSession(true);
    setStatus('Error: ' + err.message, 'error');
  }finally{
    state.busy = false; setControls();
  }
}

async function stopSession(silent = false){
  if(state.stopping) return;
  const { engine, pipeline, vad } = state;
  if(!engine && !pipeline) { state.running = false; setControls(); return; }
  state.stopping = true; state.running = false; setControls();
  if(!silent) setStatus('Stopping…', 'busy');
  try{ if(engine?.usesVAD) vad?.flush(); }catch{}
  state.unsubVad?.();
  try{ await engine?.stop(); }catch(e){ log('Stop error: ' + e.message, 'warn'); }
  pipeline?.stop();
  stopVisuals();
  vadIndicator.classList.remove('on');
  vadIndicator.textContent = 'VOICE';
  setTalk(false);
  state.engine = state.pipeline = state.vad = state.unsubVad = null;
  if(!engine?.usesVAD) interimEl.textContent = '';
  activeModeEl.textContent = '—';
  state.stopping = false; setControls();
  if(!silent){ setStatus('Stopped', 'idle'); log('Session stopped.'); }
  saveSession();
}

async function transcribeFile(file){
  if(state.running || state.busy){ log('Stop the live session before transcribing a file.', 'warn'); return; }
  const def = engineDef(settings.engine);
  if(!def.file){ log(`${def.name} only supports live microphone input. Choose Whisper, Vosk, or a cloud engine for files.`, 'warn'); return; }
  state.busy = true; setControls();
  try{
    setStatus(`Decoding ${file.name}…`, 'busy');
    showProgress(-1, 'Decoding audio…');
    const pcm = await decodeFileTo16k(file);
    showProgress(null);
    if(!state.sessionId) newSession();
    const lastEnd = state.segments.reduce((m, s) => Math.max(m, s.end || 0), 0);
    state.captureOffset = state.segments.length ? Math.ceil(lastEnd) + 1 : 0;
    state.engineName = def.name;
    activeModeEl.textContent = def.name;
    log(`Transcribing ${file.name} (${fmtClock(pcm.length / TARGET_RATE)}) with ${def.name}.`);
    const engine = def.create(getEngineOpts(def.id), makeEnv());
    setStatus(`Transcribing ${file.name}…`, 'busy');
    await engine.transcribeFile(pcm, p => showProgress(p, `Transcribing ${file.name} — ${Math.round(p * 100)}%`));
    setStatus('File transcription complete', 'idle');
    log('File transcription complete.');
  }catch(err){
    log('File transcription failed: ' + err.message, 'error');
    setStatus('Error: ' + err.message, 'error');
  }finally{
    showProgress(null);
    interimEl.textContent = '';
    activeModeEl.textContent = '—';
    state.busy = false; setControls();
    fileInput.value = '';
    saveSession();
  }
}

function clearAll(){
  saveSession();
  state.sessionId = null;
  state.segments = []; state.pending = [];
  if(state.running) newSession(true);
  setEditing(false);
  renderSegments(); renderPreview(); renderTranscript(); renderHistory();
  confidenceEl.textContent = '—';
  log('Transcript cleared (previous session kept in history).');
}

/* =========================================================
   Settings UI
========================================================= */
function buildEngineSelect(){
  const sel = $('engineSelect');
  const groups = new Map();
  for(const e of ENGINES){
    if(!groups.has(e.group)){ const g = document.createElement('optgroup'); g.label = e.group; groups.set(e.group, g); sel.append(g); }
    groups.get(e.group).append(new Option(e.name, e.id));
  }
  sel.value = engineDef(settings.engine).id;
}
function renderEngineInfo(){
  const def = engineDef(settings.engine);
  const el = $('engineInfo');
  const badge = document.createElement('span');
  badge.className = 'badge ' + (def.privacy === 'private' ? 'private' : 'cloud');
  badge.textContent = def.privacy === 'private' ? 'On-device' : def.privacy === 'custom' ? 'Your server' : 'Cloud';
  const fileNote = def.file ? ' File transcription supported.' : ' Live microphone only.';
  el.replaceChildren(badge, def.info + fileNote);
}
function renderEngineFields(){
  const def = engineDef(settings.engine);
  const opts = getEngineOpts(def.id);
  const box = $('engineFields');
  box.replaceChildren();
  renderEngineInfo();
  for(const f of def.fields){
    if(f.type === 'action'){
      const btn = document.createElement('button');
      btn.className = 'ghost'; btn.type = 'button'; btn.textContent = f.label;
      btn.addEventListener('click', () => f.run(btn));
      box.append(btn);
      continue;
    }
    if(f.type === 'checkbox'){
      const label = document.createElement('label'); label.className = 'toggle';
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!opts[f.key];
      input.addEventListener('change', () => setEngineOpt(def.id, f, input.checked));
      const span = document.createElement('span'); span.textContent = f.label;
      label.append(input, ' ', span);
      box.append(label);
      continue;
    }
    const label = document.createElement('label'); label.className = 'field';
    const span = document.createElement('span'); span.textContent = f.label;
    let input;
    if(f.type === 'select'){
      input = document.createElement('select');
      for(const [v, t] of f.options) input.append(new Option(t, v));
      input.value = opts[f.key];
    } else if(f.type === 'textarea'){
      input = document.createElement('textarea'); input.rows = 2; input.value = opts[f.key]; input.spellcheck = false;
    } else {
      input = document.createElement('input');
      input.type = f.type === 'password' ? 'password' : 'text';
      input.value = opts[f.key];
      input.autocomplete = 'off'; input.spellcheck = false;
      if(f.placeholder) input.placeholder = f.placeholder;
    }
    input.addEventListener(f.type === 'select' ? 'change' : 'input', () => setEngineOpt(def.id, f, input.value));
    label.append(span, input);
    box.append(label);
  }
  setControls();
}

async function checkInstallOnDevice(btn){
  const lang = settings.lang;
  btn.disabled = true;
  try{
    let st = await chromeOnDeviceStatus(lang);
    log(`On-device status for ${lang}: ${st}.`);
    if(st === 'downloadable' || st === 'downloading'){
      setStatus(`Installing on-device pack for ${lang}…`, 'busy');
      showProgress(-1, 'Downloading language pack (Chrome manages this download)…');
      const ok = await chromeOnDeviceInstall(lang);
      st = await chromeOnDeviceStatus(lang);
      log(ok ? `Language pack for ${lang} installed (${st}).` : `Install did not complete (${st}).`, ok ? 'info' : 'warn');
    }
    setStatus(`On-device ${lang}: ${st}`, st === 'available' ? 'idle' : 'error');
  }catch(e){
    log('On-device install failed: ' + e.message, 'error');
    setStatus('On-device install failed', 'error');
  }finally{
    showProgress(null);
    btn.disabled = state.running || state.busy;
  }
}

async function refreshDevices(){
  if(!navigator.mediaDevices?.enumerateDevices) return;
  try{
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const sel = $('micSelect');
    sel.replaceChildren(new Option('Default microphone', ''), ...devs.map((d, i) => new Option(d.label || `Microphone ${i + 1}`, d.deviceId)));
    sel.value = devs.some(d => d.deviceId === settings.deviceId) ? settings.deviceId : '';
  }catch{}
}

function applyTheme(){
  document.documentElement.dataset.theme = settings.theme;
  $('themeBtn').textContent = settings.theme === 'dark' ? 'Light' : 'Dark';
  readColors();
  if(!rafId) drawIdle();
}

function updateTester(){
  const v = $('testInput').value.trim();
  const out = $('testOutput');
  if(!v){ out.textContent = ''; return; }
  renderDiff(out, v, cleanTranscript(v, cleanOpts()));
}

function bindSettings(){
  const bindCheck = (id, key, after) => {
    const el = $(id); el.checked = !!settings[key];
    el.addEventListener('change', () => { settings[key] = el.checked; saveSettings(); after?.(); });
  };
  const bindRange = (id, key, labelId, fmt, after) => {
    const el = $(id), lab = $(labelId);
    el.value = settings[key]; lab.textContent = fmt(settings[key]);
    el.addEventListener('input', () => { settings[key] = Number(el.value); lab.textContent = fmt(settings[key]); saveSettings(); after?.(); });
  };

  $('engineSelect').addEventListener('change', e => { settings.engine = e.target.value; saveSettings(); renderEngineFields(); });
  $('langSelect').value = settings.lang;
  $('langSelect').addEventListener('change', e => { settings.lang = e.target.value; saveSettings(); });
  $('micSelect').addEventListener('change', e => { settings.deviceId = e.target.value; saveSettings(); });
  $('refreshMicsBtn').addEventListener('click', refreshDevices);

  bindCheck('rememberKeys', 'rememberKeys', () => log(settings.rememberKeys ? 'API keys will be stored in this browser.' : 'Stored API keys removed.'));
  bindCheck('nsToggle', 'ns'); bindCheck('ecToggle', 'ec'); bindCheck('agcToggle', 'agc');
  bindCheck('strictMode', 'strict', updateTester);
  bindCheck('autoAccept', 'autoAccept');
  bindRange('gainRange', 'gain', 'gainVal', v => v.toFixed(1) + '×', () => state.pipeline?.setGain(settings.gain));
  bindRange('vadRange', 'vadSens', 'vadVal', v => String(v), () => { if(state.vad) state.vad.factor = 1.6 + (10 - settings.vadSens) * 0.45; });
  bindRange('thresholdRange', 'threshold', 'thresholdVal', v => v + '%');
  const applyGate = () => { state.pipeline?.setGate(gateLevel(settings.gate), settings.ptt); updateGateMarker(); };
  bindRange('gateRange', 'gate', 'gateVal', v => v ? `${v} (≥ ${Math.round(20 * Math.log10(gateLevel(v)))} dBFS)` : 'Off', applyGate);
  bindCheck('pttToggle', 'ptt', () => { $('talkBtn').hidden = !settings.ptt; applyGate(); });
  $('talkBtn').hidden = !settings.ptt;
  updateGateMarker();
  const boostEl = $('boostSelect');
  boostEl.value = settings.boost;
  boostEl.addEventListener('change', () => { settings.boost = boostEl.value; saveSettings(); log(`Vocabulary boost: ${settings.boost} (applies on next Start).`); });

  const talk = $('talkBtn');
  talk.addEventListener('pointerdown', e => { e.preventDefault(); talk.setPointerCapture(e.pointerId); pressTalk(); });
  talk.addEventListener('pointerup', () => setTalk(false));
  talk.addEventListener('pointercancel', () => setTalk(false));

  const vocabEl = $('vocab');
  vocabEl.value = settings.vocab;
  let vt = null;
  vocabEl.addEventListener('input', () => {
    clearTimeout(vt);
    vt = setTimeout(() => { settings.vocab = vocabEl.value; vocabCache = null; saveSettings(); updateTester(); }, 300);
  });
  $('resetVocabBtn').addEventListener('click', () => {
    vocabEl.value = settings.vocab = DEFAULT_VOCAB; vocabCache = null; saveSettings(); updateTester(); log('Vocabulary reset to defaults.');
  });
  $('testInput').addEventListener('input', updateTester);

  $('themeBtn').addEventListener('click', () => { settings.theme = settings.theme === 'dark' ? 'light' : 'dark'; saveSettings(); applyTheme(); });
  $('shortcutsBtn').addEventListener('click', () => $('shortcutsDlg').showModal());
}

/* =========================================================
   Wiring
========================================================= */
startBtn.addEventListener('click', startSession);
stopBtn.addEventListener('click', () => stopSession());
clearBtn.addEventListener('click', clearAll);
fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; if(f) transcribeFile(f); });
$('acceptBtn').addEventListener('click', acceptCurrent);
$('rejectBtn').addEventListener('click', rejectCurrent);
$('editBtn').addEventListener('click', () => setEditing(!state.editing));
$('copyBtn').addEventListener('click', copyTranscript);
$('exportTxt').addEventListener('click', () => exportAs('txt'));
$('exportJson').addEventListener('click', () => exportAs('json'));
$('exportSrt').addEventListener('click', () => exportAs('srt'));
$('clearLogBtn').addEventListener('click', () => logEl.replaceChildren());
$('clearHistoryBtn').addEventListener('click', () => {
  if(!confirm('Delete all saved sessions?')) return;
  localStorage.removeItem(LS_HISTORY); renderHistory(); log('History cleared.');
});

document.addEventListener('keydown', e => {
  if($('shortcutsDlg').open) return;
  const t = e.target;
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable;
  if(e.ctrlKey || e.metaKey){
    if(e.key === 'Enter'){ e.preventDefault(); acceptCurrent(); }
    else if(e.key.toLowerCase() === 's'){ e.preventDefault(); exportAs('txt'); }
    return;
  }
  if(e.key === 'Escape'){
    if(state.editing){ e.preventDefault(); setEditing(false); }
    else if(state.pending.length && !typing){ e.preventDefault(); rejectCurrent(); }
    return;
  }
  if(typing || t.tagName === 'BUTTON') return;
  if(e.code === 'Space'){
    e.preventDefault();
    if(settings.ptt){ if(!e.repeat) pressTalk(); return; }
    if(state.running) stopSession(); else startSession();
  }
});
document.addEventListener('keyup', e => {
  if(e.code === 'Space' && settings.ptt) setTalk(false);
});
window.addEventListener('blur', () => setTalk(false));

function pressTalk(){
  if(!state.running && !state.busy) startSession();
  setTalk(true);
}
function setTalk(held){
  state.talking = held;
  state.pipeline?.setTalk(held);
  $('talkBtn').classList.toggle('active', held);
}
function updateGateMarker(){
  const m = $('meter-gate');
  const lvl = gateLevel(settings.gate);
  m.hidden = !lvl || settings.ptt;
  m.style.bottom = Math.min(100, lvl * 400) + '%';
}

navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
window.addEventListener('resize', sizeCanvas);
window.addEventListener('beforeunload', saveSession);

/* =========================================================
   Init
========================================================= */
buildEngineSelect();
bindSettings();
applyTheme();
renderEngineFields();
sizeCanvas();
refreshDevices();
renderSegments();
renderHistory();
if(location.protocol === 'file:'){
  flashAlert('Opened as a local file: Whisper, Vosk and the audio worklet cannot run this way. Double-click start-webtok.cmd in this folder to open it at http://localhost:8080 instead.', true);
  log('Page opened from file:// — run start-webtok.cmd to serve it over http://localhost.', 'warn');
}
if(!SR) log('Web Speech API not available in this browser — use Whisper, Vosk, or a cloud engine.', 'warn');
log('Ready. Press Start (or Space). Pick an engine on the left.');
setStatus('Idle');
})();

/* Voxoira auto-language: shows every page in the visitor's language (saved choice, else browser language).
   Translates interface text only — never the user's own transcripts, editors or AI chat. Results are cached in the browser. */
(function(){
'use strict';
var doc=document,root=doc.documentElement,KEY='voxoira-ui-lang',RTL=['ar','he','fa','ur'],CK='vx-tl4-';
var SKIP='script,style,noscript,textarea,input,select,option,code,pre,kbd,[contenteditable],[translate=no],.no-translate,#d-liveText,#t-liveText,#ai-live-text,#aiChat,#t-translatedBox';
var LIVE='#d-liveText,#t-liveText,#ai-live-text',ASKIP='script,style,[translate=no],.no-translate,#aiChat,#t-translatedBox';
var ATTR=['placeholder','aria-label','title','alt'],ASEL='[placeholder],[aria-label],[title],[alt]';
var IDLE=['Start the microphone and speak. Live words will appear instantly.','Start the microphone and speak. Live words will appear here while you talk.'];
var origTitle=doc.title,target='en',cache={},gen=0,orig=new WeakMap(),done=new WeakMap(),touched=[],tAttrs=[],dynLeft=40,saveT,pending=[],flushT;
function norm(raw){var l=String(raw||'').replace('_','-').toLowerCase(),b=l.split('-')[0];if(l.indexOf('zh')===0)b=/tw|hk|hant/.test(l)?'zh-TW':'zh-CN';if(b==='nb'||b==='nn')b='no';if(b==='tl')b='fil';return b||'en'}
function pick(){var s=null;try{s=localStorage.getItem(KEY)}catch(e){}if(s)return s;var p=(navigator.languages&&navigator.languages.length)?navigator.languages:[navigator.language];return norm(p[0])}
function clean(t){return t.replace(/\s+/g,' ').trim()}
function curated(){return !!(window.VT&&window.VT('home','~')!=='~')}
function siteDone(p){var l=(root.lang||'en').toLowerCase();return l!=='en'&&l.split('-')[0]===target.toLowerCase().split('-')[0]&&!!p.closest('[data-i18n]')}
function loadCache(){try{cache=JSON.parse(localStorage.getItem(CK+target)||'{}')}catch(e){cache={}}}
function saveCache(){clearTimeout(saveT);saveT=setTimeout(function(){try{localStorage.setItem(CK+target,JSON.stringify(cache))}catch(e){}},600)}

function collect(rt,dyn){
  var out=[],n,w=doc.createTreeWalker(rt,NodeFilter.SHOW_TEXT,null),cur=curated();
  if(rt.nodeType===3){w=null;n=rt;var q=[rt]}
  function take(n){var p=n.parentElement,raw=n.nodeValue;if(!p||!/[A-Za-z\u00C0-\u024F]{2}/.test(raw))return;
    var live=p.closest(LIVE);if(live){if(IDLE.indexOf(clean(raw))<0)return}else if(p.closest(SKIP))return;
    if(cur&&p.closest('[data-t]'))return;if(done.get(n)===raw)return;if(dyn&&/\d/.test(raw))return;
    out.push({t:clean(raw),ap:function(tr){if(!n.parentNode)return;var r=n.nodeValue;if(!orig.has(n))orig.set(n,r);n.nodeValue=r.match(/^\s*/)[0]+tr+r.match(/\s*$/)[0];done.set(n,n.nodeValue);touched.push(n)}})}
  if(w){while(n=w.nextNode())take(n)}else take(rt);
  var els=rt.nodeType===1?[rt].concat([].slice.call(rt.querySelectorAll(ASEL))):(rt===doc?[].slice.call(doc.querySelectorAll(ASEL)):[]);
  els.forEach(function(el){if(el.closest(ASKIP))return;ATTR.forEach(function(a){var v=el.getAttribute&&el.getAttribute(a);if(!v||!/[A-Za-z\u00C0-\u024F]{2}/.test(v))return;
    el.__vx=el.__vx||{};if(el.__vx[a]&&el.__vx[a].d===v)return;if(cur&&el.closest('[data-tp]')&&a==='placeholder')return;if(dyn&&/\d/.test(v))return;
    out.push({t:clean(v),ap:function(tr){var c=el.getAttribute(a);el.__vx[a]={o:(el.__vx[a]&&el.__vx[a].o)||c,d:tr};el.setAttribute(a,tr);tAttrs.push([el,a])}})})});
  return out}

function fetchLines(lines,tl){
  var url='https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='+encodeURIComponent(tl)+'&dt=t&q='+encodeURIComponent(lines.join('\n'));
  return fetch(url).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(j){var s='';(j[0]||[]).forEach(function(x){if(x&&x[0])s+=x[0]});var o=s.split('\n').map(function(x){return x.trim()});while(o.length>lines.length&&o[o.length-1]==='')o.pop();return o})}
function translateBatch(lines,tl){
  return fetchLines(lines,tl).then(function(o){if(o.length===lines.length)return o;if(lines.length===1)return [o.join(' ')];
    var h=Math.ceil(lines.length/2);return Promise.all([translateBatch(lines.slice(0,h),tl),translateBatch(lines.slice(h),tl)]).then(function(r){return r[0].concat(r[1])})})}

function run(items,dyn){
  var my=gen,tl=target,need={};
  items.forEach(function(it){var c=cache[it.t];if(c)it.ap(c);else(need[it.t]=need[it.t]||[]).push(it)});
  var keys=Object.keys(need),batches=[],cur=[],len=0;
  keys.forEach(function(k){if(cur.length&&(len+k.length>1500||cur.length>=40)){batches.push(cur);cur=[];len=0}cur.push(k);len+=k.length+1});if(cur.length)batches.push(cur);
  if(dyn){if(batches.length>dynLeft)batches=batches.slice(0,dynLeft);dynLeft-=batches.length}
  var i=0;function next(){if(i>=batches.length||my!==gen)return Promise.resolve();var b=batches[i++];
    return translateBatch(b,tl).then(function(o){if(my!==gen)return;b.forEach(function(k,j){if(o[j]){cache[k]=o[j];need[k].forEach(function(it){it.ap(o[j])})}});saveCache()}).catch(function(){}).then(next)}
  return Promise.all([next(),next(),next()])}

function setTarget(t){
  gen++;target=t||'en';pending=[];
  doc.title=origTitle;
  touched.forEach(function(n){if(orig.has(n)&&n.parentNode)n.nodeValue=orig.get(n)});touched=[];
  tAttrs.forEach(function(p){var s=p[0].__vx&&p[0].__vx[p[1]];if(s)p[0].setAttribute(p[1],s.o)});tAttrs=[];done=new WeakMap();
  if(target.toLowerCase().split('-')[0]==='en'){target='en';return}
  loadCache();
  if(RTL.indexOf(target.split('-')[0])>=0)root.dir='rtl';
  if(!root.lang||root.lang.toLowerCase()==='en')root.lang=target;
  var items=collect(doc.body,false);
  var tc=clean(origTitle);if(tc){items.push({t:tc,ap:function(tr){doc.title=tr}})}
  run(items,false)}

function flush(){if(target==='en')return;var list=pending;pending=[];var items=[];
  list.forEach(function(n){if(n.isConnected===false)return;if(n.nodeType===3||n.nodeType===1)items=items.concat(collect(n,true))});
  if(items.length)run(items,true)}
function init(){
  setTarget(pick());
  new MutationObserver(function(ms){if(target==='en')return;ms.forEach(function(m){if(m.type==='childList')[].forEach.call(m.addedNodes,function(a){pending.push(a)});else pending.push(m.target)});clearTimeout(flushT);flushT=setTimeout(flush,250)})
   .observe(doc.body,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:ATTR});
  var _s=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){_s.apply(this,arguments);if(k===KEY)setTimeout(function(){setTarget(v)},400)}}
function start(){setTimeout(init,350)}
if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',start);else start();
})();

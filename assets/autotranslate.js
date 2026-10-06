/* Voxoira: translate the whole page into the visitor's language (browser language on first visit,
   or the language chosen on the site). English visitors and search crawlers see the original English. */
(function(){
  var CUR=['es','fr','de','fi','pt'],RTL=['ar','he','iw','fa','ur'];
  function ls(k,v){try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v)}catch(e){return null}}
  function pick(){
    var s=ls('voxoira-ui-lang');if(s)return s;
    var p=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language];
    for(var i=0;i<p.length;i++){var l=String(p[i]||'').replace('_','-').toLowerCase(),b=l.split('-')[0];if(!b)continue;
      if(l.indexOf('zh')===0)return /tw|hk|hant/.test(l)?'zh-TW':'zh-CN';
      if(b==='nb'||b==='nn')return 'no';if(b==='tl')return 'fil';if(b==='he')return 'iw';return b}
    return 'en'}
  var lang=pick(),cache={},nodes=null,attrs=[],busy=0,setDir=false,pending={},timer;
  var LET=/\p{L}/u,norm=function(s){return s.replace(/\s+/g,' ').trim()};
  function base(){return lang.split('-')[0]}
  function loadCache(){try{cache=JSON.parse(ls('vx-at-'+lang)||'{}')||{}}catch(e){cache={}}}
  function saveCache(){var j=JSON.stringify(cache);if(j.length<2500000)ls('vx-at-'+lang,j)}
  if(lang!=='en')loadCache();
  function curated(){return CUR.indexOf(base())>=0}
  function skipEl(e){
    for(var x=e;x&&x.nodeType===1;x=x.parentNode){
      if(/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|CODE|PRE|KBD|SVG|SELECT|OPTION|IFRAME|CANVAS)$/i.test(x.tagName))return true;
      var ce=x.getAttribute('contenteditable');if(ce!==null&&ce!=='false')return true;
      if(x.getAttribute('translate')==='no'||x.classList.contains('notranslate')||x.classList.contains('ui-lang'))return true;
      if(x.hasAttribute('data-i18n')||(curated()&&x.hasAttribute('data-t')))return true;
      if(x.id&&/(liveText|liveStatus)$/.test(x.id))return true}
    return false}
  function worth(t){return t.length>1&&LET.test(t)&&!/^[\w.+-]+@[\w.-]+\.\w+$/.test(t)&&t!=='Voxoira'&&!/^https?:/.test(t)}
  function scan(){
    nodes=[];attrs=[];
    var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null),n;
    while((n=w.nextNode())){var t=norm(n.data);if(worth(t)&&!skipEl(n.parentNode))nodes.push({n:n,o:n.data,t:t,c:n.data})}
    [].forEach.call(document.querySelectorAll('[placeholder],[title],[aria-label]'),function(el){
      if(el.closest&&el.closest('.ui-lang'))return;
      ['placeholder','title','aria-label'].forEach(function(a){var v=el.getAttribute(a);if(!v)return;
        if(a==='placeholder'&&(el.hasAttribute('data-i18n-ph')||(curated()&&el.hasAttribute('data-tp'))))return;
        var t=norm(v);if(worth(t))attrs.push({el:el,a:a,o:v,t:t,c:v})})});
    var dt=norm(document.title);if(worth(dt))attrs.push({el:document,a:'title',o:document.title,t:dt,c:document.title})}
  function wrap(o,tr){return (o.match(/^\s*/)[0])+tr+(o.match(/\s*$/)[0])}
  function apply(){
    nodes.forEach(function(r){var tr=cache[r.t];if(tr&&r.n.data===r.c){r.c=wrap(r.o,tr);r.n.data=r.c}});
    attrs.forEach(function(r){var tr=cache[r.t];if(!tr)return;
      var cur=r.a==='title'&&r.el===document?document.title:r.el.getAttribute(r.a);
      if(cur===r.c){r.c=tr;if(r.el===document)document.title=tr;else r.el.setAttribute(r.a,tr)}})}
  function restore(){
    if(!nodes)return;
    nodes.forEach(function(r){if(r.n.data===r.c){r.n.data=r.o;r.c=r.o}});
    attrs.forEach(function(r){var cur=r.el===document?document.title:r.el.getAttribute(r.a);
      if(cur===r.c){r.c=r.o;if(r.el===document)document.title=r.o;else r.el.setAttribute(r.a,r.o)}});
    if(setDir){document.documentElement.dir='ltr';setDir=false}}
  function tr(q,tl){
    return fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl='+encodeURIComponent(tl)+'&dt=t&q='+encodeURIComponent(q))
      .then(function(r){return r.ok?r.json():null}).then(function(d){return d?d[0].map(function(x){return x[0]}).join(''):null}).catch(function(){return null})}
  function batch(arr,tl){
    return tr(arr.join('\n'),tl).then(function(o){
      if(o==null)return;var p=o.split('\n');
      if(p.length===arr.length){arr.forEach(function(s,i){if(p[i].trim())cache[s]=p[i].trim()})}
      else return Promise.all(arr.map(function(s){return tr(s,tl).then(function(r){if(r)cache[s]=r.trim()})}))})}
  function chunks(list){var out=[],cur=[],len=0;list.forEach(function(s){if(len+s.length>1300&&cur.length){out.push(cur);cur=[];len=0}cur.push(s);len+=s.length+1});if(cur.length)out.push(cur);return out}
  function pool(list,tl,done){
    var q=chunks(list),active=0,i=0;
    (function next(){while(active<4&&i<q.length){active++;batch(q[i++],tl).then(function(){active--;if(tl===lang){apply();saveCache()}next()})}
      if(!active&&i>=q.length&&done)done()})()}
  function run(){
    if(lang==='en'){return}
    if(RTL.indexOf(base())>=0&&document.documentElement.dir!=='rtl'){document.documentElement.dir='rtl';setDir=true}
    if(!nodes)scan();
    apply();
    var miss={};nodes.concat(attrs).forEach(function(r){if(!cache[r.t])miss[r.t]=1});
    var list=Object.keys(miss);if(list.length)pool(list,lang)}
  /* for strings built by page scripts: returns a cached translation now, or English now and the translation soon */
  window.vxT=function(s){
    if(lang==='en'||typeof s!=='string')return s;var t=norm(s);if(cache[t])return cache[t];
    if(worth(t)&&!pending[t]){pending[t]=1;clearTimeout(timer);timer=setTimeout(function(){var l=Object.keys(pending);pending={};pool(l,lang)},200)}
    return s};
  var wait;
  function relang(){
    clearTimeout(wait);wait=setTimeout(function(){
      var t=pick();if(t===lang)return;
      restore();lang=t;cache={};if(lang!=='en')loadCache();run()},400)}
  new MutationObserver(relang).observe(document.documentElement,{attributes:true,attributeFilter:['lang']});
  function start(){setTimeout(run,700)}
  if(document.readyState==='complete')start();else window.addEventListener('load',start);
})();

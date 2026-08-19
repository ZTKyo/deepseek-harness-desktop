(function(){
  if (window.__dshQuotaInjected) return;
  window.__dshQuotaInjected = true;
  function findSidebar(){
    var all = document.querySelectorAll('*'), found = null;
    for (var i=0;i<all.length;i++){
      try {
        var el = all[i];
        if (getComputedStyle(el).getPropertyValue('--dsh-sidebar-inline-padding')){
          var r = el.getBoundingClientRect();
          // last VISIBLE, in-flow candidate wins -> the real sidebar, even when the
          // layout re-renders and produces a second (hidden) match
          if (r && r.width > 40 && r.height > 100) found = el;
        }
      } catch(e){}
    }
    return found;
  }
  var sb = findSidebar();
  if(!sb) return;
  // The --dsh-sidebar-inline-padding scan can match a NARROW sub-list (observed:
  // a 2-child "qDHVXG_list" holding 未分组+设置). For a STABLE pinned position we
  // anchor on the "设置/Settings" leaf and insert above it inside ITS OWN parent
  // (the bottom zone: under 未分组, above 设置) - exactly the empty area the user
  // pointed at.
  function findSettingAnchor(){
    var best = null;
    (function walk(el, d){
      if (d > 9 || !el) return;
      for (var i=0;i<el.children.length;i++){
        var c = el.children[i];
        var txt = (c.textContent||'').replace(/\s+/g,' ').trim();
        var cls = ((c.className||'') + '').toString();
        if (txt === '设置' || txt === 'Settings' || /(^|\s)settings($|\s)/i.test(cls)) {
          try { var r = c.getBoundingClientRect(); if (r.width > 0 && r.height > 0) best = c; } catch(e){}
        }
        walk(c, d+1);
      }
    })(document.body, 0);
    return best;
  }
  // ---- class-based anchor strategy (verified against the real DSH DOM, 2026-08-19) ----
  // The sidebar root is `hHd-Xa_root`; inside it: logoRow / newSession / regionArea
  // (工作区 zone) / footArea (未分组) / settingsArea (设置). The quiet spot the user
  // wants is DIRECTLY ABOVE settingsArea (below footArea).
  function q(sel){ try { return document.querySelector(sel); } catch(e){ return null; } }
  var rootEl   = q('[class*=hHd-Xa_root]') || sb;
  var setArea  = q('[class*=hHd-Xa_settingsArea]');
  var footEl   = q('[class*=hHd-Xa_footArea]');
  var regionEl = q('[class*=hHd-Xa_regionArea]');
  var newBtn   = q('[class*=hHd-Xa_newSession]');
  var holder = rootEl;                       // the container for the pinned widget
  var defaultAnchor = setArea;               // insert BEFORE the settings area (pinned spot; drag removed 2026-08-19)

  var w = document.createElement('div');
  w.id = 'dsh-quota-widget';
  w.style.cssText = 'padding:6px var(--dsh-sidebar-inline-padding,12px);font-family:inherit;';
  var card = document.createElement('div');
  card.style.cssText = 'border-radius:10px;padding:10px 12px;background:rgba(148,163,184,.08);border:1px solid rgba(148,163,184,.13);transition:background .2s;';
  card.onmouseenter = function(){ card.style.background='rgba(148,163,184,.12)'; };
  card.onmouseleave = function(){ card.style.background='rgba(148,163,184,.08)'; };
  w.appendChild(card);

  // unified typography: every provider name and every amount share one style
  var NAME_STYLE = 'font-size:12px;font-weight:600;opacity:.92;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  var BAL_STYLE = 'font-size:16px;font-weight:700;letter-spacing:.2px;margin-top:1px;';

  var hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
  var titleSpan = document.createElement('span');
  titleSpan.textContent = '额度';
  titleSpan.style.cssText = 'font-size:11px;font-weight:600;letter-spacing:.4px;opacity:.85';
  hdr.appendChild(titleSpan);
  var toggle = document.createElement('span');    // expand toggle, RIGHT, bigger
  toggle.id = 'dshq-toggle';
  toggle.textContent = '▾';
  toggle.title = '展开/收起全部提供商';
  toggle.style.cssText = 'font-size:13px;opacity:.6;cursor:pointer;user-select:none;margin-left:4px;';
  hdr.appendChild(toggle);
  card.appendChild(hdr);

  var host = document.createElement('div');
  host.id = 'dshq-providers';
  host.style.cssText = 'margin-top:6px;';
  card.appendChild(host);

  // setup (deepseek card visible but no key configured)
  var setup = document.createElement('div');
  setup.id = 'dshq-setup';
  setup.style.cssText = 'display:none;margin-top:8px;';
  setup.innerHTML = '<input id="dshq-key" type="password" placeholder="DeepSeek API Key" style="width:100%;box-sizing:border-box;font-size:11px;padding:5px 8px;border-radius:6px;border:1px solid rgba(148,163,184,.3);background:rgba(148,163,184,.08);color:inherit;outline:none;"/>'+
                    '<button id="dshq-save" style="margin-top:6px;width:100%;font-size:11px;padding:5px 0;border-radius:6px;border:1px solid rgba(148,163,184,.35);background:rgba(148,163,184,.12);color:inherit;cursor:pointer">保存</button>';
  card.appendChild(setup);

  var mimoBtn = document.createElement('button');
  mimoBtn.id='dshq-mimo-btn';
  mimoBtn.textContent='连接小米余额';
  mimoBtn.style.cssText='display:none;margin-top:6px;width:100%;font-size:11px;padding:5px 0;border-radius:6px;border:1px solid rgba(251,146,60,.45);background:rgba(251,146,60,.12);color:inherit;cursor:pointer;';
  mimoBtn.onclick=function(){ if(window.chrome && window.chrome.webview) window.chrome.webview.postMessage('__DSH_MIMO_CONNECT__'); };
  card.appendChild(mimoBtn);

  // legacy text-anchor fallback (unused since 2026-08-19: the card is pinned
  // above settingsArea and drag support was removed at the user's request)
  function findAnchor(){
    var kids = [].slice.call(sb.children);
    function sig(el){ try { return (((el.textContent||'')+' '+(el.className||'')).toLowerCase()); } catch(e){ return ''; } }
    var ST  = /设置|settings/;
    var WS  = /工作区|workspace/;
    var NEW = /新绘画|新建|新会话|添加会话|new chat|newchat/;
    // Priority: ABOVE 设置/Settings first - it is the stable bottom anchor that
    // NEVER moves when folder groups expand/collapse (that is what the user asked:
    // pinned above Settings). Then above Workspace, then below New chat.
    for (var k=0;k<kids.length;k++){ if (ST.test(sig(kids[k])))  return { mode:'before', el:kids[k] }; }
    for (var k=0;k<kids.length;k++){ if (WS.test(sig(kids[k])))  return { mode:'before', el:kids[k] }; }
    for (var k=0;k<kids.length;k++){ if (NEW.test(sig(kids[k]))) return { mode:'after',  el:kids[k] }; }
    return { mode:'top', el:null };
  }
  // find the DEEPEST visible element whose trimmed text equals kw (hash-immune)
  function findTextLeaf(kw){
    var best = null;
    (function walk(el, d){
      if (d > 9 || !el) return;
      for (var i=0;i<el.children.length;i++){
        var c = el.children[i];
        var tt = (c.textContent||'').replace(/\s+/g,' ').trim();
        if (tt === kw) { try { var r = c.getBoundingClientRect(); if (r.width > 0 && r.height > 0) best = c; } catch(e){ best = c; } }
        walk(c, d+1);
      }
    })(document.body, 0);
    return best;
  }
  function placeWidget(){
    // defensive: never throw, never lose the card. Prefer the exact 设置 text leaf
    // (insert ABOVE it inside its own parent), then class anchors, then body.
    try {
      if (w.parentNode) { try { w.parentNode.removeChild(w); } catch(e){} }
      var setLeaf = findTextLeaf('\u8bbe\u7f6e');   // 设置
      if (setLeaf && setLeaf.parentElement) { setLeaf.parentElement.insertBefore(w, setLeaf); return; }
      if (defaultAnchor && holder && holder.contains(defaultAnchor)) { holder.insertBefore(w, defaultAnchor); return; }
      if (sb) { sb.insertBefore(w, sb.firstChild); return; }
      document.body.appendChild(w);
    } catch(e){ try { if (!w.parentNode) document.body.appendChild(w); } catch(e2){} }
  }
  // diagnostic self-report -> logged by the host as "WD [...]"
  try {
    var sbInfo = ((holder.className||'') + '').toString().slice(0,60) + ' #kids=' + holder.children.length;
    var wIdx = [].indexOf.call(holder.children, w);
    var dbg = 'fixed=above-settings idx=' + wIdx + ' sb=' + sbInfo;
    if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage('__DSH_Q_DBG__' + JSON.stringify(dbg));
  } catch(e){}

  // (toggle/save binding moved to the very end, AFTER placeWidget() inserts the
  // card into the DOM - getElementById only resolves once the node is attached)
  function fmtMoney(sym, v){
    return (sym==='USD'?'$':'¥') + Number(v).toFixed(2);
  }
  function subCardContent(p){
    var wrap=document.createElement('div');
    wrap.style.cssText='margin-top:4px;';
    var barWrap=document.createElement('div');
    barWrap.style.cssText='height:6px;border-radius:3px;background:rgba(148,163,184,.16);overflow:hidden;';
    var bar=document.createElement('div');
    bar.style.cssText='height:100%;width:0%;border-radius:3px;background:linear-gradient(90deg,#a78bfa,#f472b6);transition:width .5s ease;';
    barWrap.appendChild(bar);
    wrap.appendChild(barWrap);
    var info=document.createElement('div');
    info.style.cssText='margin-top:5px;font-size:11px;opacity:.85;line-height:1.6;white-space:pre;';
    wrap.appendChild(info);
    var ww=p.windows;
    if (ww) {
      var month=ww.monthly||ww.weekly||ww.rolling;
      if (month && typeof month.percent==='number') {
        // OpenCode Go usage API returns percent as an integer 0-100 (16 = 16%).
        // The bar shows the REMAINING share: the more you use, the shorter it gets.
        var used=Math.max(0,Math.min(100,Math.round(month.percent)));
        var remain=Math.max(0,100-used);
        bar.style.width=remain+'%';
        var txt='本月剩余 '+remain+'%（已用 '+used+'%）';
        if (month.resetsAt) {
          var rd=new Date(month.resetsAt);
          if(!isNaN(rd.getTime())){
            var mm=('0'+(rd.getMonth()+1)).slice(-2), dd=('0'+rd.getDate()).slice(-2);
            txt+=' · 重置 '+mm+'-'+dd;
          }
        }
        if (ww.rolling && typeof ww.rolling.percent==='number') txt+='\n滚动 '+Math.round(ww.rolling.percent)+'%';
        if (ww.weekly && typeof ww.weekly.percent==='number') txt+=' · 周 '+Math.round(ww.weekly.percent)+'%';
        info.textContent=txt;
      }
    } else if (p.error) {
      info.textContent=p.error;
    }
    return wrap;
  }
  function balCardContent(p){
    var val=document.createElement('div');
    val.style.cssText=BAL_STYLE;
    if (p.connected===false) val.textContent='未连接';
    else if (p.needKey) val.textContent='未设置 API Key';
    else if (typeof p.remaining==='number') val.textContent='剩余 '+fmtMoney(p.currency,p.remaining);
    else val.textContent=(p.error||'额度获取失败');
    return val;
  }
  function render(d){
    lastData=d;
    var hostEl=document.getElementById('dshq-providers');
    hostEl.innerHTML='';
    var list=(d.providers)||[];
    var visible=[];
    if (expanded) {
      visible=list;
    } else {
      for (var i=0;i<list.length;i++){
        if (list[i].id===d.current) visible.push(list[i]);
      }
      if (visible.length===0) visible=list; // unknown/empty current -> show all
    }
    for (var j=0;j<visible.length;j++){
      var p=visible[j];
      var box=document.createElement('div');
      box.style.cssText='padding:6px 0;'+(j>0?'border-top:1px solid rgba(148,163,184,.1);':'');
      var name=document.createElement('div');
      name.style.cssText=NAME_STYLE;
      name.textContent=p.name||'?';
      box.appendChild(name);
      box.appendChild(p.kind==='subscription'?subCardContent(p):balCardContent(p));
      hostEl.appendChild(box);
    }
    // mimo connect button: only when a mimo card is visible and disconnected
    var hasMimoVis=false, mimoDisc=false;
    for (var m=0;m<visible.length;m++){
      if (visible[m].id==='mimo'){ hasMimoVis=true; if(!visible[m].connected) mimoDisc=true; }
    }
    var mb=document.getElementById('dshq-mimo-btn');
    if(mb) mb.style.display=(hasMimoVis&&mimoDisc)?'block':'none';
    // deepseek key setup: only when a deepseek card is visible and needs a key
    var dsNeed=false;
    for (var n=0;n<visible.length;n++){
      if (visible[n].id==='deepseek' && visible[n].needKey) dsNeed=true;
    }
    var setupEl=document.getElementById('dshq-setup');
    if(setupEl) setupEl.style.display=dsNeed?'block':'none';
    if(!window.__dshMimoVerified){ window.__dshMimoVerified=true; try{ window.chrome.webview.postMessage('__DSH_Q_MIMO_OK__'); }catch(e){} }
  }
  window.__dshQuotaUpdate=render;
  if(window.chrome && window.chrome.webview){
    window.chrome.webview.addEventListener('message',function(ev){ try{ render(JSON.parse(ev.data)); }catch(e){} });
  }
  // insert the card LAST, after every handler is registered, so an insertion
  // failure can never kill the render chain (2026-08-19 fix)
  placeWidget();
  // bind expand/save AFTER the card is in the DOM (lookup only works then)
  var expanded = false;
  var lastData = null;
  var toggleEl = document.getElementById('dshq-toggle');
  if (toggleEl) toggleEl.onclick=function(){
    expanded = !expanded;
    var te = document.getElementById('dshq-toggle');
    if (te) te.textContent = expanded ? '▴' : '▾';
    if (lastData) render(lastData);
  };
  var saveEl = document.getElementById('dshq-save');
  if (saveEl) saveEl.onclick=function(){
    var v=document.getElementById('dshq-key').value.trim();
    if(v && window.chrome && window.chrome.webview) window.chrome.webview.postMessage(v);
  };
})();

(function(){
  if (window.__dshQuotaInjected) return;
  window.__dshQuotaInjected = true;
  function findSidebar(){
    var all = document.querySelectorAll('*');
    for (var i=0;i<all.length;i++){
      try {
        if (getComputedStyle(all[i]).getPropertyValue('--dsh-sidebar-inline-padding')) return all[i];
      } catch(e){}
    }
    return null;
  }
  var sb = findSidebar();
  if(!sb) return;
  var foot = null;
  for (var k=0;k<sb.children.length;k++){
    var c = sb.children[k];
    var cls = (c.className||'').toString() + ' ' + (c.textContent||'');
    if (cls.indexOf('foot')>=0 || cls.indexOf('设置')>=0 || cls.indexOf('settings')>=0){ foot = c; break; }
  }
  if(!foot) foot = sb.children[sb.children.length-1];

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
  hdr.innerHTML = '<span style="font-size:11px;font-weight:600;letter-spacing:.4px;opacity:.85">额度</span>'+
                  '<span id="dshq-toggle" title="展开/收起全部提供商" style="font-size:10px;opacity:.55;cursor:pointer;user-select:none">▾</span>';
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

  sb.insertBefore(w, foot);

  var expanded = false;
  var lastData = null;
  document.getElementById('dshq-toggle').onclick=function(){
    expanded = !expanded;
    document.getElementById('dshq-toggle').textContent = expanded ? '▴' : '▾';
    if (lastData) render(lastData);
  };
  document.getElementById('dshq-save').onclick=function(){
    var v=document.getElementById('dshq-key').value.trim();
    if(v && window.chrome && window.chrome.webview) window.chrome.webview.postMessage(v);
  };
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
        var pct=Math.max(0,Math.min(100,Math.round(month.percent*100)));
        bar.style.width=pct+'%';
        var txt='本月已用 '+pct+'%';
        if (month.resetsAt) {
          var rd=new Date(month.resetsAt);
          if(!isNaN(rd.getTime())){
            var mm=('0'+(rd.getMonth()+1)).slice(-2), dd=('0'+rd.getDate()).slice(-2);
            txt+=' · 重置 '+mm+'-'+dd;
          }
        }
        if (ww.rolling && typeof ww.rolling.percent==='number') txt+='\n滚动 '+Math.round(ww.rolling.percent*100)+'%';
        if (ww.weekly && typeof ww.weekly.percent==='number') txt+=' · 周 '+Math.round(ww.weekly.percent*100)+'%';
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
})();

// The document each design renders in: the reviewer's sandboxed iframes and bin/shot both use it.
// Loaded as a CommonJS module by the server and inlined into the reviewer page.
function buildPreview(contentHtml, mockupId, caseKey = null) {
  const scr = 'script';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>*,*::before,*::after{box-sizing:border-box}body{margin:0;padding:0;font-family:Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;overflow-x:hidden}</style>
<${scr} src="https://cdn.tailwindcss.com"></${scr}>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400;1,600&family=Crimson+Pro:ital,wght@0,400;0,500;0,600;1,400&family=DM+Sans:ital,wght@0,400;0,500;0,700;1,400&family=EB+Garamond:ital,wght@0,400;0,500;0,700;1,400;1,500&family=Instrument+Serif:ital@0;1&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400;1,700&family=Space+Grotesk:wght@400;500;700&family=Space+Mono:wght@400;700&family=Syne:wght@400;500;600;700&display=swap" rel="stylesheet">
<${scr} src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></${scr}>
${caseKey === null ? '' : `<${scr}>window.mockupCaseKey=${JSON.stringify(caseKey).replace(/</g, '\\u003c')};Object.defineProperty(window,"mockupCase",{configurable:true,get:function(){return window.mockupData&&window.mockupData[window.mockupCaseKey]}})</${scr}>`}
</head><body>
${contentHtml}
<${scr}>(function(){
if(window.lucide)try{lucide.createIcons()}catch(e){}
// Close dialog forms locally; sandboxed previews cannot submit forms.
document.addEventListener("click",function(e){if(e.defaultPrevented)return;var button=e.target.closest("button,input[type=submit]");if(!button||button.type!=="submit")return;var form=button.form,method=button.getAttribute("formmethod")||form?.getAttribute("method");if(!form||method?.toLowerCase()!=="dialog")return;var dialog=form.closest("dialog");if(!dialog)return;e.preventDefault();if(form.noValidate||button.formNoValidate||form.reportValidity())dialog.close(button.value)});
var id=${JSON.stringify(mockupId)};
function report(){parent.postMessage({type:"mockup-resize",id:id,height:document.documentElement.scrollHeight},"*")}
new ResizeObserver(report).observe(document.documentElement);
window.addEventListener("load",report);
var point=false,scrollTimer;
window.addEventListener("message",function(e){if(e.source!==parent)return;if(e.data?.type==="review-point-mode")point=e.data.enabled;if(e.data?.type==="review-scroll")window.scrollTo(e.data.x||0,e.data.y||0)});
document.addEventListener("click",function(e){if(!point)return;e.preventDefault();e.stopImmediatePropagation();var el=e.target.closest("[data-region]")||e.target;parent.postMessage({type:"review-point",id:id,region:el.dataset.region||el.getAttribute("aria-label")||el.tagName.toLowerCase(),text:(el.innerText||el.textContent||"").trim().slice(0,120)},"*")},true);
document.addEventListener("keydown",function(e){if(e.altKey&&["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)){e.preventDefault();parent.postMessage({type:"review-key",id:id,key:e.key},"*")}});
window.addEventListener("scroll",function(){clearTimeout(scrollTimer);scrollTimer=setTimeout(function(){parent.postMessage({type:"review-scroll",id:id,x:scrollX,y:scrollY},"*")},100)});

var n=0,t=setInterval(function(){report();if(++n>=20)clearInterval(t)},200);
})()</${scr}>
</body></html>`;
}

if (typeof module !== "undefined") module.exports = { buildPreview };

/**
 * Behaviors: event → action pairs attached to page elements, in the manner of the Behaviors panels of
 * desktop web editors, but stored as data and wired up by unobtrusive vanilla JavaScript.
 *
 * Each element keeps its behaviors in a data-ql-behaviors attribute (a JSON array). One generated script
 * block, <script id="ql-behaviors">, at the end of the body reads those attributes when the page loads and
 * attaches the listeners. The block is regenerated from every element's attribute whenever behaviors
 * change, so it never drifts from the data and running it twice does no harm.
 *
 * Everything in this module is pure (no editor or DOM access) so it can be unit-tested.
 */

export const BEHAVIOR_ATTR = 'data-ql-behaviors';
export const BEHAVIOR_SCRIPT_ID = 'ql-behaviors';
export const VALIDATION_SCRIPT_ID = 'ql-validation';

export type BehaviorEvent = 'click' | 'dblclick' | 'mouseover' | 'mouseout' | 'focus' | 'blur' | 'change' | 'submit' | 'load' | 'keydown';

export interface Behavior {
  event: BehaviorEvent | string;
  action: string;
  params: Record<string, any>;
}

export const EVENTS: { value: BehaviorEvent; label: string }[] = [
  { value: 'click', label: 'Click (onclick)' },
  { value: 'dblclick', label: 'Double-click (ondblclick)' },
  { value: 'mouseover', label: 'Pointer enters (onmouseover)' },
  { value: 'mouseout', label: 'Pointer leaves (onmouseout)' },
  { value: 'focus', label: 'Gets focus (onfocus)' },
  { value: 'blur', label: 'Loses focus (onblur)' },
  { value: 'change', label: 'Value changes (onchange)' },
  { value: 'submit', label: 'Form is submitted (onsubmit)' },
  { value: 'load', label: 'Page loads (onload)' },
  { value: 'keydown', label: 'Key is pressed (onkeydown)' },
];

export interface ParamDef {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'checkbox' | 'number';
  options?: { value: string; label: string }[];
  value?: any;
  help?: string;
  placeholder?: string;
}

export interface ActionDef {
  id: string;
  label: string;
  icon: string;
  /** Command id that adds this action (behavior.<id>). */
  origin: string;
  /** Default event when the action is added. */
  event?: BehaviorEvent;
  params: ParamDef[];
  note?: string;
  /** One-line description of an instance, for lists. */
  summary: (p: Record<string, any>) => string;
}

const TARGETS = [{ value: '_self', label: 'Same window' }, { value: '_blank', label: 'New window' }, { value: '_parent', label: 'Parent frame' }, { value: '_top', label: 'Whole window (leave frames)' }];

export const ACTIONS: ActionDef[] = [
  { id: 'swapImage', label: 'Swap Image', icon: 'swap_horiz', origin: 'Dreamweaver, Expression Web', event: 'mouseover',
    params: [
      { key: 'target', label: 'Image id (empty: this element)', type: 'text', placeholder: 'logo' },
      { key: 'src', label: 'New image address', type: 'text', placeholder: 'images/button-over.png' },
      { key: 'preload', label: 'Preload the new image', type: 'checkbox', value: true },
      { key: 'restore', label: 'Restore on pointer leave', type: 'checkbox', value: true },
    ], summary: (p) => `${p.target ? '#' + p.target : 'this image'} → ${p.src || '?'}` },
  { id: 'swapRestore', label: 'Swap Image Restore', icon: 'settings_backup_restore', origin: 'Dreamweaver, Expression Web', event: 'mouseout',
    params: [], summary: () => 'restore swapped images' },
  { id: 'preloadImages', label: 'Preload Images', icon: 'downloading', origin: 'Dreamweaver, Expression Web', event: 'load',
    params: [{ key: 'images', label: 'Image addresses (one per line)', type: 'textarea' }],
    summary: (p) => `${lines(p.images).length} image(s)` },
  { id: 'popupMessage', label: 'Popup Message', icon: 'chat', origin: 'Dreamweaver, Expression Web', event: 'click',
    params: [{ key: 'message', label: 'Message', type: 'textarea', value: 'Hello!' }],
    summary: (p) => `"${short(p.message)}"` },
  { id: 'openWindow', label: 'Open Browser Window', icon: 'open_in_new', origin: 'Dreamweaver, Expression Web', event: 'click',
    params: [
      { key: 'url', label: 'Address', type: 'text', placeholder: 'https://example.com/' },
      { key: 'name', label: 'Window name', type: 'text', value: '' },
      { key: 'width', label: 'Width', type: 'number', value: 640 },
      { key: 'height', label: 'Height', type: 'number', value: 480 },
      { key: 'popup', label: 'Open as a popup window (no toolbars)', type: 'checkbox', value: true },
    ], summary: (p) => `${p.url || '?'} (${p.width || 'auto'}×${p.height || 'auto'})` },
  { id: 'goToUrl', label: 'Go to URL', icon: 'link', origin: 'Dreamweaver, Expression Web', event: 'click',
    params: [
      { key: 'url', label: 'Address', type: 'text', placeholder: 'page.html' },
      { key: 'target', label: 'Open in', type: 'select', options: TARGETS, value: '_self' },
    ], summary: (p) => `${p.url || '?'}${p.target && p.target !== '_self' ? ` (${p.target})` : ''}` },
  { id: 'jumpMenu', label: 'Jump Menu', icon: 'menu_open', origin: 'Dreamweaver, Expression Web', event: 'change',
    params: [{ key: 'target', label: 'Open in', type: 'select', options: TARGETS, value: '_self' }],
    note: 'Attach to a drop-down box (select) whose option values are addresses.',
    summary: (p) => `go to the chosen option${p.target && p.target !== '_self' ? ` (${p.target})` : ''}` },
  { id: 'showHide', label: 'Show-Hide Elements', icon: 'visibility', origin: 'Dreamweaver, Expression Web', event: 'click',
    params: [
      { key: 'show', label: 'Show (ids, comma-separated)', type: 'text' },
      { key: 'hide', label: 'Hide (ids)', type: 'text' },
      { key: 'toggle', label: 'Toggle (ids)', type: 'text' },
    ], summary: (p) => [p.show && `show ${p.show}`, p.hide && `hide ${p.hide}`, p.toggle && `toggle ${p.toggle}`].filter(Boolean).join('; ') || 'nothing' },
  { id: 'changeProperty', label: 'Change Property', icon: 'tune', origin: 'Dreamweaver, Expression Web', event: 'click',
    params: [
      { key: 'target', label: 'Element id (empty: this element)', type: 'text' },
      { key: 'property', label: 'CSS property', type: 'text', placeholder: 'background-color' },
      { key: 'value', label: 'New value', type: 'text', placeholder: '#ffeeaa' },
      { key: 'restore', label: 'Restore on pointer leave / blur', type: 'checkbox', value: false },
    ], summary: (p) => `${p.target ? '#' + p.target : 'this'} ${p.property || '?'}: ${p.value ?? ''}` },
  { id: 'setText', label: 'Set Text', icon: 'text_fields', origin: 'Dreamweaver, Expression Web', event: 'click',
    params: [
      { key: 'kind', label: 'Set the text of', type: 'select', options: [{ value: 'element', label: 'An element (container)' }, { value: 'field', label: 'A form field' }, { value: 'status', label: 'The status bar (page title)' }], value: 'element' },
      { key: 'target', label: 'Element or field id', type: 'text' },
      { key: 'text', label: 'Text', type: 'textarea' },
    ], summary: (p) => `${p.kind === 'status' ? 'status' : '#' + (p.target || '?')} = "${short(p.text)}"` },
  { id: 'validateForm', label: 'Validate Form', icon: 'fact_check', origin: 'Dreamweaver, Expression Web', event: 'submit',
    params: [
      { key: 'rules', label: 'Fields to check (one per line: id or name, then required, email, number or url)', type: 'textarea', placeholder: 'name required\nemail email required\nage number' },
      { key: 'message', label: 'Message heading', type: 'text', value: 'Please correct the following:' },
    ], note: 'Attach to a form (submit event). Browsers also check the HTML5 constraint attributes; see Form Validation.',
    summary: (p) => `${lines(p.rules).length} field rule(s)` },
  { id: 'playSound', label: 'Play Sound', icon: 'volume_up', origin: 'Dreamweaver, FrontPage', event: 'click',
    params: [{ key: 'src', label: 'Sound file address', type: 'text', placeholder: 'media/click.mp3' }, { key: 'volume', label: 'Volume (0–1)', type: 'number', value: 1 }],
    summary: (p) => p.src || '?' },
  { id: 'callScript', label: 'Call Script', icon: 'code', origin: 'Dreamweaver, Expression Web', event: 'click',
    params: [{ key: 'code', label: 'JavaScript (the variables event and element are available; return false to cancel)', type: 'textarea', value: '' }],
    summary: (p) => short(p.code) || '(empty)' },
  { id: 'checkBrowser', label: 'Check Browser Features', icon: 'travel_explore', origin: 'Dreamweaver (Check Browser)', event: 'load',
    params: [
      { key: 'feature', label: 'Feature the page needs', type: 'select', value: 'fetch', options: [
        { value: 'fetch', label: 'fetch()' }, { value: 'grid', label: 'CSS Grid' }, { value: 'flex', label: 'CSS Flexbox' }, { value: 'customProperties', label: 'CSS custom properties' },
        { value: 'serviceWorker', label: 'Service workers' }, { value: 'intersectionObserver', label: 'IntersectionObserver' }, { value: 'webp', label: 'WebP images (via picture support)' },
        { value: 'dialog', label: '<dialog> element' }, { value: 'localStorage', label: 'Local storage' }, { value: 'touch', label: 'Touch input' }] },
      { key: 'ifMissing', label: 'Go to this address when missing', type: 'text', placeholder: 'basic.html' },
      { key: 'ifPresent', label: 'Go to this address when present (optional)', type: 'text' },
    ], note: 'Modern practice is feature detection, not browser names: the script tests the feature itself.',
    summary: (p) => `${p.feature || 'fetch'}? ${p.ifPresent || 'stay'} : ${p.ifMissing || 'stay'}` },
  { id: 'effects', label: 'Effects', icon: 'animation', origin: 'Dreamweaver (Spry effects)', event: 'click',
    params: [
      { key: 'effect', label: 'Effect', type: 'select', value: 'fade', options: [{ value: 'fade', label: 'Fade' }, { value: 'slide', label: 'Slide (collapse)' }, { value: 'highlight', label: 'Highlight' }, { value: 'grow', label: 'Grow / shrink' }, { value: 'shake', label: 'Shake' }] },
      { key: 'target', label: 'Element id (empty: this element)', type: 'text' },
      { key: 'mode', label: 'Direction', type: 'select', value: 'toggle', options: [{ value: 'toggle', label: 'Toggle' }, { value: 'out', label: 'Out (hide)' }, { value: 'in', label: 'In (show)' }] },
      { key: 'duration', label: 'Duration (ms)', type: 'number', value: 400 },
      { key: 'color', label: 'Highlight color', type: 'text', value: '#fff3a0' },
    ], note: 'Uses CSS transitions; users who prefer reduced motion see the end state at once.',
    summary: (p) => `${p.effect || 'fade'} ${p.mode || 'toggle'} ${p.target ? '#' + p.target : 'this'}` },
  { id: 'dragElement', label: 'Drag Element', icon: 'drag_pan', origin: 'Dreamweaver (Drag AP Element)', event: 'load',
    params: [
      { key: 'target', label: 'Element id (empty: this element)', type: 'text' },
      { key: 'handle', label: 'Drag handle id (optional)', type: 'text' },
      { key: 'constrain', label: 'Keep inside the parent element', type: 'checkbox', value: false },
    ], summary: (p) => `make ${p.target ? '#' + p.target : 'this'} draggable` },
  { id: 'statusBar', label: 'Set Status Bar Text', icon: 'short_text', origin: 'Dreamweaver, FrontPage (status bar)', event: 'mouseover',
    params: [{ key: 'text', label: 'Text', type: 'text' }, { key: 'useTitle', label: 'Show it in the page title instead (restored on pointer leave)', type: 'checkbox', value: true }],
    note: 'Browsers no longer let pages change the status bar; the text can be shown in the page title instead.',
    summary: (p) => `"${short(p.text)}"` },
];

export const actionDef = (id: string): ActionDef | undefined => ACTIONS.find((a) => a.id === id);

export function lines(s: any): string[] {
  return String(s ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}
function short(s: any, n = 40): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** Reads a data-ql-behaviors value. Invalid or missing values give an empty list. */
export function parseBehaviors(attr: string | null | undefined): Behavior[] {
  if (!attr) return [];
  try {
    const v = JSON.parse(attr);
    if (!Array.isArray(v)) return [];
    return v.filter((b) => b && typeof b === 'object' && typeof b.action === 'string' && typeof b.event === 'string')
      .map((b) => ({ event: b.event, action: b.action, params: b.params && typeof b.params === 'object' ? b.params : {} }));
  } catch { return []; }
}

export function serializeBehaviors(list: Behavior[]): string | null {
  return list.length ? JSON.stringify(list.map((b) => ({ event: b.event, action: b.action, params: b.params || {} }))) : null;
}

export function describeBehavior(b: Behavior): string {
  const a = actionDef(b.action);
  const ev = EVENTS.find((e) => e.value === b.event)?.value || b.event;
  return `on${ev}: ${a?.label || b.action}${a ? ' – ' + a.summary(b.params || {}) : ''}`;
}

// ------------------------------------------------------------------------------------------
// Script generation

/** Runtime implementation of each action: function (el, p, ev, ctx). Returning false cancels the event. */
const RUNTIME: Record<string, string> = {
  swapImage: `function(el,p,ev){var img=p.target?byId(p.target):el;if(!img||!p.src)return;if(img.tagName!=='IMG'){img=img.querySelector('img')||img;}if(!img.hasAttribute('data-ql-swap'))img.setAttribute('data-ql-swap',img.getAttribute('src')||'');img.setAttribute('src',p.src);swapped.push(img);if(p.restore!==false&&el.__qlSwapRestore!==true){el.__qlSwapRestore=true;el.addEventListener('mouseout',restoreSwaps);el.addEventListener('blur',restoreSwaps);}}`,
  swapRestore: `function(){restoreSwaps();}`,
  preloadImages: `function(el,p){String(p.images||'').split(/[\\r\\n,]+/).map(function(x){return x.trim();}).filter(Boolean).forEach(function(u){var i=new Image();i.src=u;preloaded.push(i);});}`,
  popupMessage: `function(el,p){window.alert(String(p.message==null?'':p.message));}`,
  openWindow: `function(el,p,ev){if(!p.url)return;var f=[];if(p.width)f.push('width='+(+p.width));if(p.height)f.push('height='+(+p.height));if(p.popup!==false&&(p.width||p.height))f.push('popup=yes');var w=window.open(p.url,p.name||'_blank',f.join(','));if(w){try{w.opener=null;}catch(e){}}if(ev&&el.tagName==='A')return false;}`,
  goToUrl: `function(el,p,ev){if(!p.url)return;go(p.url,p.target);if(ev&&el.tagName==='A')return false;}`,
  jumpMenu: `function(el,p){var v=el.value;if(v==null&&el.querySelector){var s=el.querySelector('select');v=s&&s.value;}if(v)go(v,p.target);}`,
  showHide: `function(el,p){ids(p.show).forEach(function(i){var e=byId(i);if(e){e.hidden=false;if(e.style.display==='none')e.style.display='';}});ids(p.hide).forEach(function(i){var e=byId(i);if(e)e.hidden=true;});ids(p.toggle).forEach(function(i){var e=byId(i);if(e)e.hidden=!e.hidden;});}`,
  changeProperty: `function(el,p){var t=p.target?byId(p.target):el;if(!t||!p.property)return;var prop=String(p.property).trim();var old=t.style.getPropertyValue(prop);t.style.setProperty(prop,String(p.value==null?'':p.value));if(p.restore&&!t['__qlRestore'+prop]){t['__qlRestore'+prop]=true;var back=function(){t.style.setProperty(prop,old);};el.addEventListener('mouseout',back);el.addEventListener('blur',back);}}`,
  setText: `function(el,p){var s=String(p.text==null?'':p.text);if(p.kind==='status'){window.status=s;document.title=s;return;}var t=p.target?byId(p.target):el;if(!t)return;if(p.kind==='field'||'value' in t&&/^(INPUT|TEXTAREA|SELECT|OUTPUT)$/.test(t.tagName))t.value=s;else t.textContent=s;}`,
  validateForm: `function(el,p,ev){var form=el.tagName==='FORM'?el:el.form||el.closest('form');if(!form)return;var errs=[],first=null;lines(p.rules).forEach(function(line){var parts=line.split(/[\\s,]+/),key=parts.shift();var f=form.querySelector('#'+cssEsc(key))||form.elements[key];if(!f)return;if(f.length&&!f.tagName)f=f[0];var v=String(f.value||'').trim(),label=labelOf(f,key);parts.forEach(function(r){r=r.toLowerCase();var bad=r==='required'&&(f.type==='checkbox'||f.type==='radio'?!form.querySelector('[name="'+cssEsc(f.name)+'"]:checked'):!v)||v&&(r==='email'&&!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v)||r==='number'&&!isFinite(Number(v))||r==='url'&&!/^[a-z][a-z0-9+.-]*:\\/\\/\\S+$/i.test(v));if(bad){errs.push(label+(r==='required'?' is required.':' must be '+(r==='email'?'an email address.':r==='number'?'a number.':'a web address.')));if(!first)first=f;}});});if(errs.length){window.alert((p.message||'Please correct the following:')+'\\n\\n'+errs.join('\\n'));if(first&&first.focus)first.focus();return false;}}`,
  playSound: `function(el,p){if(!p.src||typeof Audio==='undefined')return;var a=sounds[p.src]||(sounds[p.src]=new Audio(p.src));try{a.currentTime=0;}catch(e){}if(p.volume!=null&&p.volume!=='')a.volume=Math.max(0,Math.min(1,+p.volume));var r=a.play();if(r&&r.catch)r.catch(function(){});}`,
  checkBrowser: `function(el,p){var ok=has(p.feature||'fetch');var to=ok?p.ifPresent:p.ifMissing;if(to)go(to,'_self');}`,
  effects: `function(el,p){var t=p.target?byId(p.target):el;if(t)effect(t,p);}`,
  dragElement: `function(el,p){var t=p.target?byId(p.target):el;if(t)draggable(t,p.handle?byId(p.handle):null,!!p.constrain);}`,
  statusBar: `function(el,p){var s=String(p.text==null?'':p.text);try{window.status=s;}catch(e){}if(p.useTitle!==false){if(el.__qlTitle==null){el.__qlTitle=document.title;el.addEventListener('mouseout',function(){document.title=el.__qlTitle;});el.addEventListener('blur',function(){document.title=el.__qlTitle;});}document.title=s;}}`,
};

/** Helper functions, included only when an action that needs them is used. */
const HELPERS: Record<string, { code: string; needs?: string[] }> = {
  byId: { code: `function byId(i){return i?document.getElementById(String(i).replace(/^#/,'')):null;}` },
  ids: { code: `function ids(s){return String(s||'').split(/[\\s,]+/).filter(Boolean);}` },
  lines: { code: `function lines(s){return String(s||'').split(/\\r?\\n/).map(function(x){return x.trim();}).filter(Boolean);}` },
  go: { code: `function go(u,t){if(/^\\s*javascript:/i.test(u))return;t=t||'_self';if(t==='_self')location.href=u;else if(t==='_top')(window.top||window).location.href=u;else if(t==='_parent')(window.parent||window).location.href=u;else{var w=window.open(u,t);if(w&&t==='_blank'){try{w.opener=null;}catch(e){}}}}` },
  swap: { code: `var swapped=[];function restoreSwaps(){while(swapped.length){var i=swapped.pop();if(i.hasAttribute('data-ql-swap')){i.setAttribute('src',i.getAttribute('data-ql-swap'));i.removeAttribute('data-ql-swap');}}}` },
  preloaded: { code: `var preloaded=[];` },
  sounds: { code: `var sounds={};` },
  cssEsc: { code: `function cssEsc(s){return window.CSS&&CSS.escape?CSS.escape(s):String(s).replace(/[^\\w-]/g,'\\\\$&');}` },
  labelOf: { code: `function labelOf(f,k){var l=f.id&&document.querySelector('label[for="'+cssEsc(f.id)+'"]');if(!l&&f.closest)l=f.closest('label');var t=l?l.textContent:(f.getAttribute('aria-label')||f.name||k);return String(t).replace(/[\\s:*]+$/,'').trim();}`, needs: ['cssEsc'] },
  has: { code: `function has(f){try{switch(f){case'fetch':return'fetch' in window;case'grid':return!!(window.CSS&&CSS.supports('display','grid'));case'flex':return!!(window.CSS&&CSS.supports('display','flex'));case'customProperties':return!!(window.CSS&&CSS.supports('--a','0'));case'serviceWorker':return'serviceWorker' in navigator;case'intersectionObserver':return'IntersectionObserver' in window;case'webp':return document.createElement('canvas').toDataURL('image/webp').indexOf('data:image/webp')===0;case'dialog':return typeof HTMLDialogElement==='function';case'localStorage':try{localStorage.setItem('ql-t','1');localStorage.removeItem('ql-t');return true;}catch(e){return false;}case'touch':return'ontouchstart' in window||navigator.maxTouchPoints>0;default:return true;}}catch(e){return false;}}` },
  effect: { code: `function effect(t,p){var d=Math.max(0,+p.duration||400),reduce=window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;if(reduce)d=0;var hiddenNow=t.hidden||getComputedStyle(t).display==='none';var mode=p.mode==='in'||p.mode==='out'?p.mode:(hiddenNow||t.getAttribute('data-ql-fx')==='out'?'in':'out');var e=p.effect||'fade';if(e==='highlight'){var bg=t.style.backgroundColor;t.style.transition='background-color '+d+'ms';t.style.backgroundColor=p.color||'#fff3a0';setTimeout(function(){t.style.backgroundColor=bg;},d+150);return;}if(e==='shake'){if(!t.animate||reduce)return;t.animate([{transform:'translateX(0)'},{transform:'translateX(-8px)'},{transform:'translateX(8px)'},{transform:'translateX(-5px)'},{transform:'translateX(0)'}],{duration:d||400});return;}var prop=e==='slide'?'max-height':e==='grow'?'transform':'opacity';var shown=e==='slide'?t.scrollHeight+'px':e==='grow'?'scale(1)':'1';var gone=e==='slide'?'0px':e==='grow'?'scale(0)':'0';t.style.transition=prop+' '+d+'ms ease';if(e==='slide')t.style.overflow='hidden';if(mode==='in'){t.hidden=false;if(t.style.display==='none')t.style.display='';t.style.setProperty(prop,gone);void t.offsetWidth;t.style.setProperty(prop,shown);t.setAttribute('data-ql-fx','in');setTimeout(function(){if(t.getAttribute('data-ql-fx')==='in'&&e==='slide')t.style.removeProperty('max-height');},d+20);}else{t.style.setProperty(prop,shown);void t.offsetWidth;t.style.setProperty(prop,gone);t.setAttribute('data-ql-fx','out');setTimeout(function(){if(t.getAttribute('data-ql-fx')==='out')t.hidden=true;},d+20);}}` },
  draggable: { code: `function draggable(t,h,c){var g=h||t;g.style.cursor='move';g.style.touchAction='none';if(getComputedStyle(t).position==='static')t.style.position='relative';var sx,sy,ox,oy,on=false;g.addEventListener('pointerdown',function(e){if(e.button!==0)return;on=true;sx=e.clientX;sy=e.clientY;ox=parseFloat(t.style.left)||0;oy=parseFloat(t.style.top)||0;try{g.setPointerCapture(e.pointerId);}catch(x){}e.preventDefault();});g.addEventListener('pointermove',function(e){if(!on)return;var x=ox+e.clientX-sx,y=oy+e.clientY-sy;if(c&&t.parentElement){var pr=t.parentElement.getBoundingClientRect(),r=t.getBoundingClientRect();var nx=r.left+(x-(parseFloat(t.style.left)||0)),ny=r.top+(y-(parseFloat(t.style.top)||0));if(nx<pr.left)x+=pr.left-nx;if(ny<pr.top)y+=pr.top-ny;if(nx+r.width>pr.right)x-=nx+r.width-pr.right;if(ny+r.height>pr.bottom)y-=ny+r.height-pr.bottom;}t.style.left=x+'px';t.style.top=y+'px';});var end=function(){on=false;};g.addEventListener('pointerup',end);g.addEventListener('pointercancel',end);t.setAttribute('tabindex',t.getAttribute('tabindex')||'0');t.addEventListener('keydown',function(e){var k={ArrowLeft:[-10,0],ArrowRight:[10,0],ArrowUp:[0,-10],ArrowDown:[0,10]}[e.key];if(!k)return;e.preventDefault();t.style.left=((parseFloat(t.style.left)||0)+k[0])+'px';t.style.top=((parseFloat(t.style.top)||0)+k[1])+'px';});}` },
};

const ACTION_NEEDS: Record<string, string[]> = {
  swapImage: ['byId', 'swap'], swapRestore: ['swap'], preloadImages: ['preloaded'], openWindow: [], goToUrl: ['go'], jumpMenu: ['go'],
  showHide: ['byId', 'ids'], changeProperty: ['byId'], setText: ['byId'], validateForm: ['lines', 'cssEsc', 'labelOf'], playSound: ['sounds'],
  checkBrowser: ['has', 'go'], effects: ['byId', 'effect'], dragElement: ['byId', 'draggable'], statusBar: [], popupMessage: [], callScript: [],
};

/** Makes text safe inside an inline <script> element. */
export function scriptSafe(js: string): string {
  return js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

/**
 * The script that wires up every behavior on the page. `all` is every behavior of every element (only the
 * actions and helpers used are included). Returns '' when there are none.
 */
export function generateBehaviorScript(all: Behavior[]): string {
  const used = [...new Set(all.map((b) => b.action).filter((a) => a in RUNTIME || a === 'callScript'))].sort();
  if (!used.length) return '';
  const helpers = new Set<string>();
  const addHelper = (h: string) => { if (helpers.has(h)) return; for (const n of HELPERS[h]?.needs || []) addHelper(n); helpers.add(h); };
  for (const a of used) for (const h of ACTION_NEEDS[a] || []) addHelper(h);
  const order = Object.keys(HELPERS).filter((h) => helpers.has(h));
  const out: string[] = [];
  out.push('/* Behaviors – generated by Anne\'s Loom from the data-ql-behaviors attributes. Edit them in the Behaviors panel; changes here are replaced. */');
  out.push('(function () {');
  out.push("  'use strict';");
  out.push('  if (window.__qlBehaviors) return;');
  out.push('  window.__qlBehaviors = true;');
  for (const h of order) out.push('  ' + HELPERS[h].code);
  const customs = [...new Set(all.filter((b) => b.action === 'callScript').map((b) => String(b.params?.code ?? '')))];
  if (used.includes('callScript')) {
    out.push('  var custom = [');
    customs.forEach((c, i) => out.push(`    [${JSON.stringify(c)}, function (event, element) {\n${c.split('\n').map((l) => '      ' + l).join('\n')}\n    }]${i < customs.length - 1 ? ',' : ''}`));
    out.push('  ];');
  }
  out.push('  var actions = {');
  const entries = used.map((a) => a === 'callScript'
    ? `    callScript: function (el, p, ev) { for (var i = 0; i < custom.length; i++) if (custom[i][0] === String(p.code == null ? '' : p.code)) return custom[i][1].call(el, ev, el); }`
    : `    ${a}: ${RUNTIME[a]}`);
  out.push(entries.join(',\n'));
  out.push('  };');
  out.push(`  function run(el, list, type, ev) {
    var cancel = false;
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b || b.event !== type || !actions[b.action]) continue;
      try { if (actions[b.action](el, b.params || {}, ev) === false) cancel = true; } catch (e) { if (window.console) console.error('Behavior ' + b.action + ' failed', e); }
    }
    if (cancel && ev) { ev.preventDefault(); if (type === 'submit') ev.stopImmediatePropagation(); }
  }
  function wire(el) {
    if (el.__qlWired) return;
    el.__qlWired = true;
    var list;
    try { list = JSON.parse(el.getAttribute('${BEHAVIOR_ATTR}') || '[]'); } catch (e) { return; }
    if (!Array.isArray(list)) return;
    var seen = {};
    list.forEach(function (b) {
      var type = b && b.event;
      if (!type || seen[type]) return;
      seen[type] = true;
      if (type === 'load') run(el, list, 'load', null);
      else el.addEventListener(type, function (ev) { run(el, list, type, ev); });
    });
  }
  function start() { var els = document.querySelectorAll('[${BEHAVIOR_ATTR}]'); for (var i = 0; i < els.length; i++) wire(els[i]); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();`);
  return scriptSafe(out.join('\n'));
}

/**
 * Script for custom validation messages: each field's data-ql-message (and data-ql-message-<state>) replaces
 * the browser's built-in message for that field. Pure; '' when no field uses it.
 */
export function generateValidationScript(): string {
  return scriptSafe(`/* Custom validation messages – generated by Anne\'s Loom from data-ql-message attributes. */
(function () {
  'use strict';
  if (window.__qlValidation) return;
  window.__qlValidation = true;
  var states = ['valueMissing', 'typeMismatch', 'patternMismatch', 'tooLong', 'tooShort', 'rangeUnderflow', 'rangeOverflow', 'stepMismatch'];
  function msg(f) {
    if (!f.validity || f.validity.valid) return '';
    for (var i = 0; i < states.length; i++) {
      if (f.validity[states[i]]) {
        var a = f.getAttribute('data-ql-message-' + states[i].replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }));
        if (a) return a;
      }
    }
    return f.getAttribute('data-ql-message') || '';
  }
  function check(f) { if (!f.setCustomValidity) return; f.setCustomValidity(''); var m = msg(f); if (m) f.setCustomValidity(m); }
  document.addEventListener('invalid', function (e) { check(e.target); }, true);
  document.addEventListener('input', function (e) { if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-ql-message')) check(e.target); }, true);
  document.addEventListener('change', function (e) { if (e.target && e.target.hasAttribute && e.target.hasAttribute('data-ql-message')) check(e.target); }, true);
})();`);
}

/** Inline onchange handler for a jump menu (a select whose option values are addresses). */
export function jumpMenuHandler(target = '_self'): string {
  const t = target && target !== '_self' ? target : '';
  if (!t) return "if(this.value)location.href=this.value";
  if (t === '_top') return "if(this.value)top.location.href=this.value";
  if (t === '_parent') return "if(this.value)parent.location.href=this.value";
  return `if(this.value)window.open(this.value,'${t.replace(/[^\w-]/g, '')}')`;
}

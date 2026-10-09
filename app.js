const RAW_BASE = "./";
const MANIFEST_URL = RAW_BASE + "archive-manifest.json";
const VAULT_ITERATIONS = 310000;
const VAULT_MAGIC = new TextEncoder().encode("JOYARCH1");
const ANNO_KEY = "joyceArchiveV2Annotations";
const OLD_BOOKMARK_KEY = "joyceArchiveBookmarks";

let db = [];
let stats = {};
let byKey = new Map();
let childrenByPrev = new Map();
let siblingsByKey = new Map();
let annotations = loadAnnotations();
let readerKey = null;

function loadAnnotations(){
  try{
    const x = JSON.parse(localStorage.getItem(ANNO_KEY) || "{}");
    return (x && typeof x==="object") ? x : {};
  }catch{return {};}
}
function saveAnnotations(){ localStorage.setItem(ANNO_KEY, JSON.stringify(annotations)); }
function getAnno(key){ return annotations[key] || {status:"unmarked",saved:false,note:""}; }
function ensureAnno(key){
  if(!annotations[key]) annotations[key] = {status:"unmarked",saved:false,note:""};
  return annotations[key];
}
function toast(msg){
  const t=document.getElementById("toast");
  t.textContent=msg;t.style.display="block";
  clearTimeout(toast._timer);
  toast._timer=setTimeout(()=>t.style.display="none",1600);
}
const esc=s=>(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const rxEsc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const fmtDate=t=>{
  if(!t)return"unknown date";
  try{return new Date(t*1000).toLocaleString([], {year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});}
  catch{return"unknown date";}
};
function normalizeNear(s){
  return(s||"").toLowerCase().normalize("NFKD").replace(/[’‘]/g,"'").replace(/[“”]/g,'"').replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();
}
function snippetFor(text,idx,len){
  if(idx<0)idx=0;
  const start=Math.max(0,idx-280),end=Math.min(text.length,idx+Math.max(len,1)+500);
  return(start?"…":"")+text.slice(start,end)+(end<text.length?"…":"");
}
function highlight(s,query,mode){
  let out=esc(s);
  if(!query.trim())return out;
  let terms=mode==="exact"?[query.trim()]:query.trim().split(/\s+/).filter(Boolean);
  terms.sort((a,b)=>b.length-a.length);
  for(const term of terms.slice(0,16)){
    if(!term)continue;
    out=out.replace(new RegExp(rxEsc(esc(term)),"gi"),m=>`<mark>${m}</mark>`);
  }
  return out;
}
function continuityBadge(status){
  if(!status||status==="unmarked")return"";
  const label=status==="noncanon"?"NON-CANON":status.toUpperCase();
  return`<span class="badge ${status}">${label}</span>`;
}
function sourceBadge(m){ return`<span class="badge ${m.account}">${m.account_label}</span>`; }
function cssKey(k){return k.replace(/[^a-zA-Z0-9_-]/g,"_");}

function buildGraphIndexes(){
  childrenByPrev = new Map();
  for(const m of db){
    if(!childrenByPrev.has(m.prev||"__ROOT__")) childrenByPrev.set(m.prev||"__ROOT__",[]);
    childrenByPrev.get(m.prev||"__ROOT__").push(m.key);
  }
  // stable chronological sibling/version order
  for(const [k,arr] of childrenByPrev.entries()){
    arr.sort((a,b)=>(byKey.get(a)?.time||0)-(byKey.get(b)?.time||0));
  }
  siblingsByKey = new Map();
  for(const arr of childrenByPrev.values()){
    if(arr.length>1){
      for(const k of arr) siblingsByKey.set(k,arr);
    }
  }
}

function contextHTML(m){
  const prevs=[];let p=m.prev,guard=0;
  while(p&&guard++<2){
    const x=byKey.get(p);if(!x)break;
    prevs.unshift(x);p=x.prev;
  }
  const nexts=[];let q=[...(m.next||[])],seen=new Set();
  while(q.length&&nexts.length<4){
    const k=q.shift();if(seen.has(k))continue;seen.add(k);
    const x=byKey.get(k);if(!x)continue;
    nexts.push(x);
  }
  return[...prevs,m,...nexts].map(x=>`<div class="ctx ${x.key===m.key?"match":""}">
    <div class="who">${esc(x.account_label)} · ${esc(x.role)} · ${fmtDate(x.time)} ${x.key===m.key?"· MATCH":""}</div>
    <div class="body">${esc(x.text)}</div>
  </div>`).join("");
}

function renderCard(m,query,mode,matchInfo){
  const a=getAnno(m.key),snip=snippetFor(m.text,matchInfo.idx,matchInfo.len);
  const branchBadge=m.active?`<span class="badge">CURRENT BRANCH</span>`:`<span class="badge alt">ALT / EDITED BRANCH</span>`;
  const recapBadge=m.type==="reasoning_recap"?`<span class="badge">REASONING RECAP</span>`:"";
  const savedBadge=a.saved?`<span class="badge saved">SAVED</span>`:"";
  const notePreview=a.note?`<div class="notePreview">Note: ${esc(a.note.slice(0,180))}${a.note.length>180?"…":""}</div>`:"";
  const chatUrl=m.account==="current"?`https://chatgpt.com/c/${encodeURIComponent(m.conversation_id)}`:"";
  return`<article class="card ${a.saved?"saved":""}">
    <div class="cardHead">
      <div>
        <div class="title">${esc(m.title)}</div>
        <div class="meta">${fmtDate(m.time)} · ${esc(m.role)} ${m.model?"· "+esc(m.model):""}</div>
        ${notePreview}
      </div>
      <div class="badges">${sourceBadge(m)}${continuityBadge(a.status)}${savedBadge}${branchBadge}${recapBadge}</div>
    </div>
    <div class="snip">${highlight(snip,query,mode)}</div>
    <div class="actions">
      <button class="primary" onclick="openReader('${m.key}')">Read branch →</button>
      <button onclick="toggleFull('${m.key}')">Full generation</button>
      <button onclick="toggleContext('${m.key}')">Nearby turns</button>
      <button onclick="toggleAnnot('${m.key}')">Classify / note</button>
      <button onclick="toggleSaved('${m.key}')">${a.saved?"★ Saved":"☆ Save passage"}</button>
      <button onclick="copyMsg('${m.key}')">Copy</button>
      ${chatUrl?`<a class="btn" target="_blank" rel="noopener" href="${chatUrl}">Open current ChatGPT chat</a>`:""}
    </div>
    <div class="full" id="full-${cssKey(m.key)}">${esc(m.text)}</div>
    <div class="context" id="ctx-${cssKey(m.key)}">${contextHTML(m)}</div>
    <div class="annot" id="annot-${cssKey(m.key)}">
      <div class="annot-grid">
        <div>
          <div class="label">Continuity status</div>
          <select id="status-${cssKey(m.key)}" onchange="setStatus('${m.key}',this.value)">
            <option value="unmarked" ${a.status==="unmarked"?"selected":""}>Unmarked</option>
            <option value="canon" ${a.status==="canon"?"selected":""}>Canon</option>
            <option value="reference" ${a.status==="reference"?"selected":""}>Reference</option>
            <option value="noncanon" ${a.status==="noncanon"?"selected":""}>Non-canon</option>
          </select>
        </div>
        <div>
          <div class="label">Private archive note</div>
          <textarea id="note-${cssKey(m.key)}" placeholder="Why this matters, what survived into canon, voice notes…">${esc(a.note||"")}</textarea>
          <div class="row"><button onclick="saveNote('${m.key}')">Save note</button></div>
        </div>
      </div>
    </div>
  </article>`;
}

window.toggleFull=k=>{const e=document.getElementById("full-"+cssKey(k));e.style.display=e.style.display==="block"?"none":"block";}
window.toggleContext=k=>{const e=document.getElementById("ctx-"+cssKey(k));e.style.display=e.style.display==="block"?"none":"block";}
window.toggleAnnot=k=>{const e=document.getElementById("annot-"+cssKey(k));e.style.display=e.style.display==="block"?"none":"block";}
window.copyMsg=async k=>{const m=byKey.get(k);if(!m)return;await navigator.clipboard.writeText(m.text);toast("Copied generation");}
window.toggleSaved=k=>{
  const a=ensureAnno(k);a.saved=!a.saved;saveAnnotations();runSearch();if(readerKey===k)renderReader();toast(a.saved?"Passage saved":"Passage unsaved");
}
window.setStatus=(k,v)=>{
  const a=ensureAnno(k);a.status=v;saveAnnotations();runSearch();if(readerKey===k)renderReader();toast("Continuity status saved");
}
window.saveNote=k=>{
  const el=document.getElementById("note-"+cssKey(k));if(!el)return;
  const a=ensureAnno(k);a.note=el.value;saveAnnotations();runSearch();toast("Note saved");
}
window.closeHelp=()=>document.getElementById("helpModal").style.display="none";

/* Branch reader */
function branchPreview(k){
  const m=byKey.get(k);if(!m)return"";
  const text=m.text.replace(/\s+/g," ").trim();
  return text.length>170?text.slice(0,170)+"…":text;
}
function readerVersionInfo(m){
  const sibs=siblingsByKey.get(m.key)||[m.key];
  if(sibs.length<=1)return"";
  const idx=sibs.indexOf(m.key);
  return`<div class="versionBar">
    <span class="label">Sibling versions: ${idx+1} of ${sibs.length}</span>
    <button ${idx<=0?"disabled":""} onclick="openReader('${sibs[Math.max(0,idx-1)]}')">‹ Earlier version</button>
    <button ${idx>=sibs.length-1?"disabled":""} onclick="openReader('${sibs[Math.min(sibs.length-1,idx+1)]}')">Later version ›</button>
  </div>`;
}
function continuationHTML(m){
  const kids=(m.next||[]).filter(k=>byKey.has(k));
  if(kids.length<=1)return"";
  return`<div class="branchChoices">
    <div style="font-weight:700;margin-bottom:4px">This turn has ${kids.length} continuations</div>
    <div style="color:var(--muted);font-size:12px;margin-bottom:8px">Choose the path you want to follow.</div>
    ${kids.map((k,i)=>{
      const x=byKey.get(k);
      return`<button class="choice" onclick="openReader('${k}')">
        <small>Continuation ${i+1} · ${esc(x.role)} · ${fmtDate(x.time)} ${x.active?"· current branch":"· alternate branch"}</small>
        <div class="preview">${esc(branchPreview(k))}</div>
      </button>`;
    }).join("")}
  </div>`;
}
function renderReader(){
  const m=byKey.get(readerKey);if(!m)return;
  const a=getAnno(m.key);
  const sibs=siblingsByKey.get(m.key)||[m.key];
  const sidx=sibs.indexOf(m.key);
  const kids=(m.next||[]).filter(k=>byKey.has(k));
  document.getElementById("readerTitle").textContent=m.title;
  document.getElementById("readerMeta").textContent=`${m.account_label} · ${m.active?"current branch":"alternate / edited branch"} · ${fmtDate(m.time)}`;
  document.getElementById("readerBody").innerHTML=`
    <div class="readerMessage">
      <div class="readerHeader">
        <div>
          <div class="readerWho">${m.role==="user"?"JOYCE":"ASSISTANT"}</div>
          <div class="meta">${fmtDate(m.time)} ${m.model?"· "+esc(m.model):""}</div>
        </div>
        <div class="badges">${sourceBadge(m)}${continuityBadge(a.status)}${a.saved?'<span class="badge saved">SAVED</span>':""}${m.active?'<span class="badge">CURRENT BRANCH</span>':'<span class="badge alt">ALT / EDITED BRANCH</span>'}</div>
      </div>
      <div class="readerText">${esc(m.text)}</div>
      <div class="readerNote">
        ${readerVersionInfo(m)}
        <div class="readerAnnot">
          <div>
            <label>Continuity</label>
            <select id="readerStatus" onchange="readerSetStatus(this.value)">
              <option value="unmarked" ${a.status==="unmarked"?"selected":""}>Unmarked</option>
              <option value="canon" ${a.status==="canon"?"selected":""}>Canon</option>
              <option value="reference" ${a.status==="reference"?"selected":""}>Reference</option>
              <option value="noncanon" ${a.status==="noncanon"?"selected":""}>Non-canon</option>
            </select>
            <div class="row"><button onclick="readerToggleSaved()">${a.saved?"★ Saved":"☆ Save passage"}</button></div>
          </div>
          <div>
            <label>Archive note</label>
            <textarea id="readerNoteText" placeholder="Why this matters, what survived into canon, voice notes…">${esc(a.note||"")}</textarea>
            <div class="row"><button onclick="readerSaveNote()">Save note</button></div>
          </div>
        </div>
        ${continuationHTML(m)}
      </div>
    </div>`;
  const prevBtn=document.getElementById("readerPrev");
  const nextBtn=document.getElementById("readerNext");
  prevBtn.disabled=!m.prev||!byKey.has(m.prev);
  nextBtn.disabled=kids.length!==1;
  nextBtn.textContent=kids.length>1?"Choose continuation ↓":"Next →";
  document.getElementById("readerPosition").textContent=sibs.length>1?`Version ${sidx+1} of ${sibs.length}`:"";
  document.getElementById("readerBody").scrollTop=0;
}
window.openReader=k=>{
  if(!byKey.has(k))return;
  readerKey=k;
  document.getElementById("reader").style.display="block";
  document.body.style.overflow="hidden";
  renderReader();
}
window.closeReader=()=>{
  document.getElementById("reader").style.display="none";
  document.body.style.overflow="";
  readerKey=null;
}
window.readerPrev=()=>{
  const m=byKey.get(readerKey);if(m?.prev&&byKey.has(m.prev))openReader(m.prev);
}
window.readerNext=()=>{
  const m=byKey.get(readerKey);const kids=(m?.next||[]).filter(k=>byKey.has(k));
  if(kids.length===1)openReader(kids[0]);
  else if(kids.length>1)document.querySelector(".branchChoices")?.scrollIntoView({behavior:"smooth",block:"center"});
}
window.readerSetStatus=v=>{
  const a=ensureAnno(readerKey);a.status=v;saveAnnotations();renderReader();runSearch();toast("Continuity status saved");
}
window.readerToggleSaved=()=>{
  const a=ensureAnno(readerKey);a.saved=!a.saved;saveAnnotations();renderReader();runSearch();toast(a.saved?"Passage saved":"Passage unsaved");
}
window.readerSaveNote=()=>{
  const a=ensureAnno(readerKey);a.note=document.getElementById("readerNoteText").value;saveAnnotations();renderReader();runSearch();toast("Note saved");
}
document.addEventListener("keydown",e=>{
  if(document.getElementById("reader").style.display!=="block")return;
  if(e.key==="Escape")closeReader();
  if(e.key==="ArrowLeft" && !["TEXTAREA","INPUT","SELECT"].includes(document.activeElement.tagName))readerPrev();
  if(e.key==="ArrowRight" && !["TEXTAREA","INPUT","SELECT"].includes(document.activeElement.tagName))readerNext();
});

function migrateV1Bookmarks(){
  try{
    const old=JSON.parse(localStorage.getItem(OLD_BOOKMARK_KEY)||"[]");
    if(!Array.isArray(old)||!old.length)return;
    let n=0;
    for(const nodeId of old){
      const key="current:"+nodeId;
      if(byKey.has(key)){
        const a=ensureAnno(key);if(!a.saved){a.saved=true;n++;}
      }
    }
    if(n){saveAnnotations();toast(`Migrated ${n} v1 saved passage${n===1?"":"s"}`);}
  }catch{}
}

function setLoadStatus(message, isError=false){
  const el=document.getElementById("loadStatus");
  el.textContent=message;
  el.style.color=isError?"var(--noncanon)":"var(--muted)";
}

function bytesEqualPrefix(bytes,prefix){
  if(bytes.length<prefix.length)return false;
  for(let i=0;i<prefix.length;i++)if(bytes[i]!==prefix[i])return false;
  return true;
}

async function sha256Hex(bytes){
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));
  return Array.from(digest,b=>b.toString(16).padStart(2,"0")).join("");
}

async function fetchBytes(url,expectedSize,label){
  setLoadStatus(`Downloading ${label}…`);
  const res=await fetch(url,{cache:"default",referrerPolicy:"no-referrer"});
  if(!res.ok)throw new Error(`Could not download ${label} (${res.status}).`);
  const bytes=new Uint8Array(await res.arrayBuffer());
  if(expectedSize!=null&&bytes.length!==expectedSize){
    throw new Error(`${label} has an unexpected size (${bytes.length.toLocaleString()} bytes).`);
  }
  return bytes;
}

async function deriveVaultKey(passphrase,salt){
  const material=await crypto.subtle.importKey(
    "raw",new TextEncoder().encode(passphrase),"PBKDF2",false,["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {name:"PBKDF2",salt,iterations:VAULT_ITERATIONS,hash:"SHA-256"},
    material,
    {name:"AES-GCM",length:256},
    false,
    ["decrypt"]
  );
}

async function unlockArchive(){
  const passInput=document.getElementById("vaultPass");
  const unlockBtn=document.getElementById("unlockBtn");
  let passphrase=passInput.value;
  if(!passphrase){setLoadStatus("Enter the vault passphrase first.",true);passInput.focus();return;}
  unlockBtn.disabled=true;

  try{
    if(!window.crypto?.subtle)throw new Error("This browser does not provide Web Crypto.");
    if(!("DecompressionStream" in window))throw new Error("This browser does not support DecompressionStream. Use a current Chrome, Edge, or Safari.");

    setLoadStatus("Reading archive manifest…");
    const manifestRes=await fetch(MANIFEST_URL,{cache:"default",referrerPolicy:"no-referrer"});
    if(!manifestRes.ok)throw new Error(`Could not read the archive manifest (${manifestRes.status}).`);
    const manifest=await manifestRes.json();
    if(manifest.format!=="JOYARCH1-split"||!Array.isArray(manifest.parts)||!manifest.parts.length){
      throw new Error("The hosted archive manifest is not in the expected format.");
    }

    const packed=new Uint8Array(manifest.source_size);
    let offset=0;
    for(let i=0;i<manifest.parts.length;i++){
      const part=manifest.parts[i];
      const bytes=await fetchBytes(RAW_BASE+encodeURIComponent(part.name),part.size,`archive part ${i+1} of ${manifest.parts.length}`);
      setLoadStatus(`Verifying archive part ${i+1} of ${manifest.parts.length}…`);
      const partHash=await sha256Hex(bytes);
      if(partHash!==part.sha256)throw new Error(`Archive part ${i+1} failed its integrity check.`);
      packed.set(bytes,offset);
      offset+=bytes.length;
    }
    if(offset!==manifest.source_size)throw new Error("The hosted archive is incomplete.");

    setLoadStatus("Verifying complete encrypted archive…");
    const packedHash=await sha256Hex(packed);
    if(packedHash!==manifest.source_sha256)throw new Error("The complete archive failed its integrity check.");
    if(!bytesEqualPrefix(packed,VAULT_MAGIC))throw new Error("The encrypted archive header is invalid.");

    const salt=packed.slice(8,24);
    const iv=packed.slice(24,36);
    const cipher=packed.subarray(36);

    setLoadStatus("Deriving vault key locally…");
    const key=await deriveVaultKey(passphrase,salt);
    passphrase="";

    setLoadStatus("Decrypting archive locally…");
    let decrypted;
    try{
      decrypted=new Uint8Array(await crypto.subtle.decrypt({name:"AES-GCM",iv},key,cipher));
    }catch{
      throw new Error("That vault passphrase did not unlock the archive.");
    }
    packed.fill(0);
    passInput.value="";

    if(decrypted.length<2||decrypted[0]!==0x1f||decrypted[1]!==0x8b){
      throw new Error("The decrypted archive is not the expected gzip payload.");
    }

    setLoadStatus("Decompressing archive locally…");
    const stream=new Blob([decrypted]).stream().pipeThrough(new DecompressionStream("gzip"));
    const text=await new Response(stream).text();
    decrypted.fill(0);

    setLoadStatus("Building search index…");
    const payload=JSON.parse(text);
    db=payload.messages;stats=payload.stats||{};
    byKey=new Map(db.map(m=>[m.key,m]));
    buildGraphIndexes();
    migrateV1Bookmarks();

    document.getElementById("loading").remove();
    document.getElementById("app").hidden=false;
    document.getElementById("stats").innerHTML=`
      <div class="stat"><b>${(stats.current_messages||0).toLocaleString()}</b><span>current-account messages</span></div>
      <div class="stat"><b>${(stats.legacy_messages||0).toLocaleString()}</b><span>legacy-account messages</span></div>
      <div class="stat"><b>${((stats.current_conversations||0)+(stats.legacy_conversations||0)).toLocaleString()}</b><span>conversations total</span></div>
      <div class="stat"><b>${((stats.current_branching_conversations||0)+(stats.legacy_branching_conversations||0)).toLocaleString()}</b><span>conversations with branches</span></div>`;
    document.getElementById("status").textContent=`${db.length.toLocaleString()} searchable generations loaded from encrypted cloud archive.`;
    document.getElementById("q").focus();
  }catch(e){
    setLoadStatus(String(e?.message||e),true);
    unlockBtn.disabled=false;
    passInput.focus();
  }
}

function boot(){
  const pass=document.getElementById("vaultPass");
  const btn=document.getElementById("unlockBtn");
  const show=document.getElementById("showVaultPass");
  btn.addEventListener("click",unlockArchive);
  pass.addEventListener("keydown",e=>{if(e.key==="Enter")unlockArchive();});
  show.addEventListener("change",()=>{pass.type=show.checked?"text":"password";});
  if(!window.isSecureContext){
    setLoadStatus("This page must be opened over HTTPS for browser encryption to work.",true);
    btn.disabled=true;
  }
}

function matchMessage(m,query,mode){
  const text=m.text||"";
  if(mode==="exact"){
    const idx=text.toLowerCase().indexOf(query.toLowerCase());
    return idx>=0?{ok:true,idx,len:query.length}:{ok:false,idx:-1,len:0};
  }
  if(mode==="loose"){
    const terms=query.trim().split(/\s+/).filter(Boolean),low=text.toLowerCase();
    if(!terms.every(t=>low.includes(t.toLowerCase())))return{ok:false,idx:-1,len:0};
    let idx=Infinity;for(const t of terms){const i=low.indexOf(t.toLowerCase());if(i>=0)idx=Math.min(idx,i);}
    return{ok:true,idx:Number.isFinite(idx)?idx:0,len:terms[0]?.length||1};
  }
  const normText=normalizeNear(text),normQ=normalizeNear(query),direct=normText.indexOf(normQ);
  if(direct>=0){
    const first=(normQ.split(" ")[0]||query).toLowerCase(),idx=text.toLowerCase().indexOf(first);
    return{ok:true,idx:Math.max(0,idx),len:query.length};
  }
  const words=normQ.split(" ").filter(Boolean);
  if(words.length<2)return{ok:false,idx:-1,len:0};
  let pos=0,firstPos=-1,lastPos=-1;const tokens=[...normText.matchAll(/\S+/g)],vals=tokens.map(x=>x[0]);
  for(const w of words){
    let found=-1;for(let j=pos;j<Math.min(vals.length,pos+40);j++){if(vals[j]===w){found=j;break;}}
    if(found<0)return{ok:false,idx:-1,len:0};
    if(firstPos<0)firstPos=tokens[found].index;lastPos=tokens[found].index+w.length;pos=found+1;
  }
  const idx=text.toLowerCase().indexOf(words[0]);
  return{ok:true,idx:Math.max(0,idx),len:Math.max(query.length,lastPos-firstPos)};
}

let timer;
function scheduleSearch(){clearTimeout(timer);timer=setTimeout(runSearch,160);}
function runSearch(){
  const query=document.getElementById("q").value.trim(),account=document.getElementById("account").value,
    continuity=document.getElementById("continuity").value,branch=document.getElementById("branch").value,
    role=document.getElementById("role").value,mode=document.getElementById("mode").value,
    sortOrder=document.getElementById("sortOrder").value,
    savedOnly=document.getElementById("savedOnly").checked,recaps=document.getElementById("includeRecaps").checked,
    tf=document.getElementById("titleFilter").value.trim().toLowerCase(),statusEl=document.getElementById("status"),
    out=document.getElementById("results"),maxResults=300;
  const results=[];
  for(const m of db){
    if(account&&m.account!==account)continue;
    if(role&&m.role!==role)continue;
    if(branch==="current"&&!m.active)continue;
    if(branch==="alternate"&&m.active)continue;
    if(!recaps&&m.type==="reasoning_recap")continue;
    if(tf&&!m.title.toLowerCase().includes(tf))continue;
    const a=getAnno(m.key),st=a.status||"unmarked";
    if(continuity&&st!==continuity)continue;
    if(savedOnly&&!a.saved)continue;
    let mi={ok:true,idx:0,len:0};if(query)mi=matchMessage(m,query,mode);if(!mi.ok)continue;
    results.push({m,mi});
  }

  results.sort((a,b)=>{
    const at=a.m.time||0, bt=b.m.time||0;
    return sortOrder==="oldest" ? at-bt : bt-at;
  });
  const totalMatches=results.length;
  const shownResults=results.slice(0,maxResults);
  if(!query&&!tf&&!savedOnly&&!continuity&&!account&&!role&&!branch){
    statusEl.textContent=`${db.length.toLocaleString()} searchable generations loaded. Add a search or filter.`;out.innerHTML="";return;
  }
  statusEl.textContent=totalMatches>maxResults
    ? `Showing first ${maxResults} of ${totalMatches.toLocaleString()} matches · ${sortOrder==="oldest"?"oldest":"newest"} first.`
    : `${totalMatches.toLocaleString()} match${totalMatches===1?"":"es"} · ${sortOrder==="oldest"?"oldest":"newest"} first.`;
  out.innerHTML=shownResults.map(x=>renderCard(x.m,query,mode,x.mi)).join("");
}

["q","titleFilter"].forEach(id=>document.getElementById(id).addEventListener("input",scheduleSearch));
["account","continuity","branch","role","mode","sortOrder","savedOnly","includeRecaps"].forEach(id=>document.getElementById(id).addEventListener("change",runSearch));
document.getElementById("helpBtn").addEventListener("click",()=>document.getElementById("helpModal").style.display="flex");
document.getElementById("helpModal").addEventListener("click",e=>{if(e.target.id==="helpModal")closeHelp();});

document.getElementById("exportBtn").addEventListener("click",()=>{
  const data={format:"joyce-chat-archive-annotations",version:2,exported_at:new Date().toISOString(),annotations};
  const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=`joyce-archive-annotations-${new Date().toISOString().slice(0,10)}.json`;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);toast("Annotations exported");
});
document.getElementById("importBtn").addEventListener("click",()=>document.getElementById("importFile").click());
document.getElementById("importFile").addEventListener("change",async e=>{
  const file=e.target.files?.[0];if(!file)return;
  try{
    const data=JSON.parse(await file.text()),incoming=data.annotations||data;
    if(!incoming||typeof incoming!=="object"||Array.isArray(incoming))throw new Error("Invalid annotation file");
    let merged=0;
    for(const[k,v]of Object.entries(incoming)){
      if(!v||typeof v!=="object")continue;const cur=ensureAnno(k);
      if(v.status&&["unmarked","canon","reference","noncanon"].includes(v.status))cur.status=v.status;
      if(typeof v.saved==="boolean")cur.saved=v.saved;
      if(typeof v.note==="string")cur.note=v.note;
      merged++;
    }
    saveAnnotations();runSearch();toast(`Imported ${merged} annotation record${merged===1?"":"s"}`);
  }catch(err){alert("Couldn't import this annotation file: "+err);}
  e.target.value="";
});
boot();

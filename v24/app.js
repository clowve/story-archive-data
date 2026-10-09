const MANIFEST_URL = "./archive-manifest-v2_4.json";
const ANNO_KEY = "joyceArchiveV2Annotations";
const MAX_RESULTS = 300;
const MAX_SHARD_CACHE = 2;

let manifest = null;
let vaultKey = null;
let annotations = loadAnnotations();
let shardCache = new Map(); // id -> payload
let shardLRU = [];
let currentResults = new Map(); // key -> message for currently shown results
let readerKey = null;
let searchSerial = 0;
let lastSearchRan = false;

const $ = id => document.getElementById(id);

function loadAnnotations(){
  try{
    const x = JSON.parse(localStorage.getItem(ANNO_KEY) || "{}");
    return (x && typeof x === "object" && !Array.isArray(x)) ? x : {};
  }catch{return {};}
}
function saveAnnotations(){ localStorage.setItem(ANNO_KEY, JSON.stringify(annotations)); }
function getAnno(key){ return annotations[key] || {status:"unmarked",saved:false,note:""}; }
function ensureAnno(key){
  if(!annotations[key]) annotations[key] = {status:"unmarked",saved:false,note:""};
  return annotations[key];
}
function toast(msg){
  const t=$("toast"); t.textContent=msg; t.style.display="block";
  clearTimeout(toast._t); toast._t=setTimeout(()=>t.style.display="none",1700);
}
const esc=s=>(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const rxEsc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const fmtDate=t=>{
  if(!t)return"unknown date";
  try{return new Date(t*1000).toLocaleString([], {year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});}
  catch{return"unknown date";}
};
const sleep0=()=>new Promise(r=>setTimeout(r,0));

function b64urlToBytes(s){
  s=s.replace(/-/g,"+").replace(/_/g,"/");
  while(s.length%4)s+="=";
  const bin=atob(s), out=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);
  return out;
}
async function sha256Hex(bytes){
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));
  return Array.from(digest,b=>b.toString(16).padStart(2,"0")).join("");
}
async function deriveKey(pass,salt,iterations){
  const material=await crypto.subtle.importKey("raw",new TextEncoder().encode(pass),"PBKDF2",false,["deriveKey"]);
  return crypto.subtle.deriveKey(
    {name:"PBKDF2",salt,iterations,hash:"SHA-256"},
    material,
    {name:"AES-GCM",length:256},
    false,
    ["decrypt"]
  );
}
async function verifyPassphrase(key){
  const iv=b64urlToBytes(manifest.verifier.iv_b64);
  const cipher=b64urlToBytes(manifest.verifier.cipher_b64);
  try{
    const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv},key,cipher);
    return new TextDecoder().decode(plain)==="JOYARCH2-OK";
  }catch{return false;}
}
function setLoadStatus(msg,bad=false){
  const el=$("loadStatus"); el.textContent=msg; el.style.color=bad?"var(--noncanon)":"var(--muted)";
}
function setStatus(msg){ $("status").textContent=msg; }

async function unlockArchive(){
  const passEl=$("vaultPass"), btn=$("unlockBtn");
  let pass=passEl.value;
  if(!pass){setLoadStatus("Enter the vault passphrase first.",true);passEl.focus();return;}
  btn.disabled=true;
  try{
    if(!crypto?.subtle) throw new Error("This browser does not provide Web Crypto.");
    if(!("DecompressionStream" in window)) throw new Error("This browser does not support gzip decompression. Use a current Safari, Chrome, or Edge.");
    setLoadStatus("Reading v2.4 archive manifest…");
    const r=await fetch(MANIFEST_URL,{cache:"no-cache",referrerPolicy:"no-referrer"});
    if(!r.ok) throw new Error(`Could not read v2.4 manifest (${r.status}).`);
    manifest=await r.json();
    if(manifest.format!=="JOYARCH2-encrypted-shards" || !Array.isArray(manifest.shards) || !manifest.shards.length)
      throw new Error("The v2.4 manifest is not in the expected format.");

    setLoadStatus("Deriving vault key locally…");
    const salt=b64urlToBytes(manifest.kdf.salt_b64);
    const variants=[];
    const addVariant=v=>{ if(typeof v==="string" && !variants.includes(v)) variants.push(v); };
    addVariant(pass);
    addVariant(pass.trim());
    try{ addVariant(pass.normalize("NFC")); addVariant(pass.trim().normalize("NFC")); }catch{}
    try{ addVariant(pass.normalize("NFKC")); addVariant(pass.trim().normalize("NFKC")); }catch{}
    let matchedVariant=-1;
    for(let i=0;i<variants.length;i++){
      const candidate=await deriveKey(variants[i],salt,manifest.kdf.iterations);
      if(await verifyPassphrase(candidate)){ vaultKey=candidate; matchedVariant=i; break; }
    }
    pass="";
    if(!vaultKey) throw new Error("That vault passphrase did not unlock this archive.");
    passEl.value="";
    if(matchedVariant>0) toast("Vault unlocked after correcting invisible whitespace / text normalization.");

    $("loading").remove();
    $("app").hidden=false;
    renderStats();
    setStatus(`${manifest.stats.total_unique_messages.toLocaleString()} unique searchable generations ready. Searches decrypt one small shard at a time.`);
    $("q").focus();
  }catch(e){
    vaultKey=null;
    setLoadStatus(String(e?.message||e),true);
    btn.disabled=false;
    passEl.focus();
  }
}
function renderStats(){
  const s=manifest.stats||{};
  $("stats").innerHTML=`
    <div class="stat"><b>${(s.current_unique_messages||0).toLocaleString()}</b><span>current-account generations</span></div>
    <div class="stat"><b>${(s.legacy_unique_messages||0).toLocaleString()}</b><span>legacy-account generations</span></div>
    <div class="stat"><b>${((s.current_conversations||0)+(s.legacy_conversations||0)).toLocaleString()}</b><span>conversations total</span></div>
    <div class="stat"><b>${(s.messages_with_multiple_contexts||0).toLocaleString()}</b><span>messages shared across branch chats</span></div>`;
}

function fnv1a32(str){
  const bytes=new TextEncoder().encode(str);
  let h=0x811c9dc5;
  for(const b of bytes){
    h ^= b;
    h = Math.imul(h,0x01000193) >>> 0;
  }
  return h >>> 0;
}
function shardIdForKey(key){ return fnv1a32(key) % manifest.shard_count; }

function touchShard(id,payload){
  if(shardCache.has(id)) shardCache.delete(id);
  shardCache.set(id,payload);
  shardLRU=shardLRU.filter(x=>x!==id);
  shardLRU.push(id);
  while(shardLRU.length>MAX_SHARD_CACHE){
    const evict=shardLRU.shift();
    shardCache.delete(evict);
  }
}
async function loadShard(id,{cache=true,verify=true}={}){
  if(cache && shardCache.has(id)){
    const p=shardCache.get(id); touchShard(id,p); return p;
  }
  const sm=manifest.shards.find(x=>x.id===id);
  if(!sm)throw new Error(`Shard ${id} is missing from the manifest.`);
  const r=await fetch("./"+encodeURIComponent(sm.name),{cache:"default",referrerPolicy:"no-referrer"});
  if(!r.ok) throw new Error(`Could not download archive shard ${id+1} (${r.status}).`);
  const cipher=new Uint8Array(await r.arrayBuffer());
  if(cipher.length!==sm.ciphertext_bytes) throw new Error(`Shard ${id+1} has an unexpected size.`);
  if(verify){
    const hash=await sha256Hex(cipher);
    if(hash!==sm.sha256_ciphertext) throw new Error(`Shard ${id+1} failed its integrity check.`);
  }
  const iv=b64urlToBytes(sm.iv_b64);
  let gz;
  try{ gz=new Uint8Array(await crypto.subtle.decrypt({name:"AES-GCM",iv},vaultKey,cipher)); }
  catch{ throw new Error(`Shard ${id+1} could not be decrypted.`); }
  if(gz.length!==sm.plaintext_gzip_bytes || gz[0]!==0x1f || gz[1]!==0x8b)
    throw new Error(`Shard ${id+1} decrypted to unexpected data.`);
  const stream=new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
  const text=await new Response(stream).text();
  gz.fill(0);
  const payload=JSON.parse(text);
  if(payload.format!=="JOYARCH2-shard" || payload.shard!==id || !Array.isArray(payload.messages))
    throw new Error(`Shard ${id+1} payload is invalid.`);
  if(cache)touchShard(id,payload);
  return payload;
}
async function getMessage(key){
  if(currentResults.has(key))return currentResults.get(key);
  const sid=shardIdForKey(key);
  const p=await loadShard(sid,{cache:true});
  return p.messages.find(m=>m.key===key)||null;
}
async function getMessages(keys){
  const out=[];
  const missing=new Map();
  for(const key of keys){
    if(!key)continue;
    if(currentResults.has(key)){out.push(currentResults.get(key));continue;}
    const sid=shardIdForKey(key);
    if(!missing.has(sid))missing.set(sid,[]);
    missing.get(sid).push(key);
  }
  for(const [sid,need] of missing){
    const p=await loadShard(sid,{cache:true});
    const want=new Set(need);
    for(const m of p.messages)if(want.has(m.key))out.push(m);
  }
  const map=new Map(out.map(m=>[m.key,m]));
  return keys.map(k=>map.get(k)).filter(Boolean);
}

function normalizeNear(s){
  return(s||"").toLowerCase().normalize("NFKD").replace(/[’‘]/g,"'").replace(/[“”]/g,'"')
    .replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();
}
function matchMessage(m,query,mode){
  const text=m.text||"";
  if(!query)return{ok:true,idx:0,len:0};
  if(mode==="exact"){
    const idx=text.toLowerCase().indexOf(query.toLowerCase());
    return{ok:idx>=0,idx,len:query.length};
  }
  if(mode==="loose"){
    const words=query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const low=text.toLowerCase();
    if(!words.every(w=>low.includes(w)))return{ok:false,idx:-1,len:0};
    const idx=Math.min(...words.map(w=>low.indexOf(w)).filter(i=>i>=0));
    return{ok:true,idx:Math.max(0,idx),len:query.length};
  }
  const nt=normalizeNear(text), nq=normalizeNear(query);
  if(!nq)return{ok:true,idx:0,len:0};
  let pos=nt.indexOf(nq);
  if(pos>=0){
    const approx=text.toLowerCase().indexOf(query.toLowerCase().split(/\s+/)[0]||"");
    return{ok:true,idx:Math.max(0,approx),len:query.length};
  }
  const words=nq.split(" ").filter(Boolean);
  if(words.length<2)return{ok:false,idx:-1,len:0};
  let last=-1;
  for(const w of words){
    const p=nt.indexOf(w,last+1);
    if(p<0)return{ok:false,idx:-1,len:0};
    if(last>=0 && p-last>220)return{ok:false,idx:-1,len:0};
    last=p;
  }
  return{ok:true,idx:Math.max(0,text.toLowerCase().indexOf(words[0])),len:query.length};
}
function isCurrent(m){
  if(Array.isArray(m.contexts)&&m.contexts.length)return m.contexts.some(c=>!!c.active);
  return !!m.active;
}
function isAlternate(m){
  if(Array.isArray(m.contexts)&&m.contexts.length)return m.contexts.some(c=>!c.active);
  return !m.active;
}
function passesFilters(m,opt){
  if(opt.account && m.account!==opt.account)return false;
  if(opt.role && m.role!==opt.role)return false;
  if(!opt.recaps && m.type==="reasoning_recap")return false;
  if(opt.tf && !(m.title||"").toLowerCase().includes(opt.tf))return false;
  if(opt.branch==="current"&&!isCurrent(m))return false;
  if(opt.branch==="alternate"&&!isAlternate(m))return false;
  const a=getAnno(m.key), st=a.status||"unmarked";
  if(opt.continuity && st!==opt.continuity)return false;
  if(opt.savedOnly && !a.saved)return false;
  return true;
}
function compactMatch(m,mi){ return {m,mi}; }
function keepBest(arr,item,order){
  arr.push(item);
  if(arr.length>600){
    arr.sort((a,b)=>order==="oldest"?(a.m.time||0)-(b.m.time||0):(b.m.time||0)-(a.m.time||0));
    arr.length=MAX_RESULTS;
  }
}
async function runSearch(){
  if(!manifest||!vaultKey)return;
  const serial=++searchSerial;
  const query=$("q").value.trim();
  const opt={
    account:$("account").value,
    continuity:$("continuity").value,
    branch:$("branch").value,
    role:$("role").value,
    mode:$("mode").value,
    order:$("sortOrder").value,
    savedOnly:$("savedOnly").checked,
    recaps:$("includeRecaps").checked,
    tf:$("titleFilter").value.trim().toLowerCase()
  };
  if(!query && !opt.tf && !opt.savedOnly && !opt.continuity && !opt.account && !opt.role && !opt.branch){
    setStatus(`${manifest.stats.total_unique_messages.toLocaleString()} unique searchable generations ready. Enter a search or filter.`);
    $("results").innerHTML="";
    currentResults.clear();
    return;
  }

  $("searchBtn").disabled=true;
  currentResults.clear();
  $("results").innerHTML="";
  let total=0, best=[];
  try{
    for(let i=0;i<manifest.shards.length;i++){
      if(serial!==searchSerial)return;
      setStatus(`Searching shard ${i+1} of ${manifest.shards.length}…`);
      let p=await loadShard(manifest.shards[i].id,{cache:false});
      for(const m of p.messages){
        if(!passesFilters(m,opt))continue;
        const mi=query?matchMessage(m,query,opt.mode):{ok:true,idx:0,len:0};
        if(!mi.ok)continue;
        total++;
        keepBest(best,compactMatch(m,mi),opt.order);
      }
      p=null;
      await sleep0();
    }
    best.sort((a,b)=>opt.order==="oldest"?(a.m.time||0)-(b.m.time||0):(b.m.time||0)-(a.m.time||0));
    if(best.length>MAX_RESULTS)best.length=MAX_RESULTS;
    for(const x of best)currentResults.set(x.m.key,x.m);
    $("results").innerHTML=best.map(x=>renderCard(x.m,query,opt.mode,x.mi)).join("");
    setStatus(total>MAX_RESULTS
      ?`Showing first ${MAX_RESULTS} of ${total.toLocaleString()} matches · ${opt.order==="oldest"?"oldest":"newest"} first.`
      :`${total.toLocaleString()} match${total===1?"":"es"} · ${opt.order==="oldest"?"oldest":"newest"} first.`);
    lastSearchRan=true;
  }catch(e){
    setStatus("Search failed: "+String(e?.message||e));
  }finally{
    if(serial===searchSerial)$("searchBtn").disabled=false;
  }
}
function rerunIfSearched(){ if(lastSearchRan)runSearch(); }

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
function sourceBadge(m){ return`<span class="badge ${m.account}">${m.account==="current"?"CURRENT":"LEGACY"}</span>`; }
function cssKey(k){return k.replace(/[^a-zA-Z0-9_-]/g,"_");}
function branchBadge(m){
  const cur=isCurrent(m), alt=isAlternate(m);
  if(cur&&alt)return`<span class="badge alt">SHARED BRANCH HISTORY</span>`;
  return cur?`<span class="badge">CURRENT BRANCH</span>`:`<span class="badge alt">ALT / EDITED BRANCH</span>`;
}
function renderCard(m,query,mode,mi){
  const a=getAnno(m.key), snip=snippetFor(m.text||"",mi.idx,mi.len);
  const recap=m.type==="reasoning_recap"?`<span class="badge">REASONING RECAP</span>`:"";
  const saved=a.saved?`<span class="badge saved">SAVED</span>`:"";
  const note=a.note?`<div class="notePreview">Note: ${esc(a.note.slice(0,180))}${a.note.length>180?"…":""}</div>`:"";
  const chatUrl=m.account==="current"&&m.conversation_id?`https://chatgpt.com/c/${encodeURIComponent(m.conversation_id)}`:"";
  return`<article class="card ${a.saved?"saved":""}" id="card-${cssKey(m.key)}">
    <div class="cardHead"><div>
      <div class="title">${esc(m.title||"Untitled")}</div>
      <div class="meta">${fmtDate(m.time)} · ${esc(m.role)} ${m.model?"· "+esc(m.model):""}</div>${note}
    </div><div class="badges">${sourceBadge(m)}${continuityBadge(a.status)}${saved}${branchBadge(m)}${recap}</div></div>
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
    <div class="full" id="full-${cssKey(m.key)}">${esc(m.text||"")}</div>
    <div class="context" id="ctx-${cssKey(m.key)}" data-loaded="0"></div>
    <div class="annot" id="annot-${cssKey(m.key)}">
      <div class="annot-grid">
        <div><div class="label">Continuity status</div>
          <select onchange="setStatusAnno('${m.key}',this.value)">
            <option value="unmarked" ${a.status==="unmarked"?"selected":""}>Unmarked</option>
            <option value="canon" ${a.status==="canon"?"selected":""}>Canon</option>
            <option value="reference" ${a.status==="reference"?"selected":""}>Reference</option>
            <option value="noncanon" ${a.status==="noncanon"?"selected":""}>Non-canon</option>
          </select>
        </div>
        <div><div class="label">Private archive note</div>
          <textarea id="note-${cssKey(m.key)}" placeholder="Why this matters, what survived into canon, voice notes…">${esc(a.note||"")}</textarea>
          <div class="row"><button onclick="saveNote('${m.key}')">Save note</button></div>
        </div>
      </div>
    </div>
  </article>`;
}
window.toggleFull=k=>{const e=$("full-"+cssKey(k));e.style.display=e.style.display==="block"?"none":"block";};
window.toggleAnnot=k=>{const e=$("annot-"+cssKey(k));e.style.display=e.style.display==="block"?"none":"block";};
window.copyMsg=async k=>{const m=await getMessage(k);if(m){await navigator.clipboard.writeText(m.text||"");toast("Copied generation");}};
window.toggleSaved=k=>{
  const a=ensureAnno(k);a.saved=!a.saved;saveAnnotations();toast(a.saved?"Passage saved":"Passage unsaved");
  if(lastSearchRan)runSearch(); if(readerKey===k)renderReader();
};
window.setStatusAnno=(k,v)=>{const a=ensureAnno(k);a.status=v;saveAnnotations();toast("Continuity status saved");if(lastSearchRan)runSearch();if(readerKey===k)renderReader();};
window.saveNote=k=>{const e=$("note-"+cssKey(k));if(!e)return;const a=ensureAnno(k);a.note=e.value;saveAnnotations();toast("Note saved");};

window.toggleContext=async k=>{
  const e=$("ctx-"+cssKey(k));
  if(e.style.display==="block"){e.style.display="none";return;}
  e.style.display="block";
  if(e.dataset.loaded==="1")return;
  e.textContent="Loading nearby turns…";
  try{
    const m=await getMessage(k);
    const keys=[];
    if(m?.prev)keys.push(m.prev);
    keys.push(k);
    for(const n of (m?.next||[]).slice(0,3))keys.push(n);
    const msgs=await getMessages(keys);
    const map=new Map(msgs.map(x=>[x.key,x]));
    e.innerHTML=keys.map(key=>{
      const x=map.get(key);if(!x)return"";
      return`<div class="ctx ${key===k?"match":""}">
        <div class="who">${x.account==="current"?"CURRENT":"LEGACY"} · ${esc(x.role)} · ${fmtDate(x.time)} ${key===k?"· MATCH":""}</div>
        <div class="body">${esc(x.text||"")}</div></div>`;
    }).join("");
    e.dataset.loaded="1";
  }catch(err){e.textContent="Could not load nearby turns: "+String(err?.message||err);}
};

async function renderReader(){
  if(!readerKey)return;
  const body=$("readerBody");
  body.innerHTML=`<div class="readerMessage"><div class="readerText">Loading generation…</div></div>`;
  try{
    const m=await getMessage(readerKey);if(!m)throw new Error("Generation not found.");
    const a=getAnno(m.key);
    $("readerTitle").textContent=m.title||"Untitled";
    $("readerMeta").textContent=`${m.account==="current"?"CURRENT":"LEGACY"} · ${fmtDate(m.time)}`;
    const kids=(m.next||[]);
    let sibs=[];
    if(m.prev){
      const p=await getMessage(m.prev);
      sibs=(p?.next||[]).filter(Boolean);
    }
    const idx=sibs.indexOf(m.key);
    const versionBar=sibs.length>1?`<div class="versionBar">
      <span class="label">Sibling versions: ${idx+1} of ${sibs.length}</span>
      <button ${idx<=0?"disabled":""} onclick="openReader('${sibs[Math.max(0,idx-1)]}')">‹ Earlier version</button>
      <button ${idx>=sibs.length-1?"disabled":""} onclick="openReader('${sibs[Math.min(sibs.length-1,idx+1)]}')">Later version ›</button>
    </div>`:"";
    let choices="";
    if(kids.length>1){
      const km=await getMessages(kids);
      const map=new Map(km.map(x=>[x.key,x]));
      choices=`<div class="branchChoices"><div style="font-weight:700;margin-bottom:4px">This turn has ${kids.length} continuations</div>
        <div style="color:var(--muted);font-size:12px;margin-bottom:8px">Choose the path you want to follow.</div>
        ${kids.map((key,i)=>{const x=map.get(key);return x?`<button class="choice" onclick="openReader('${key}')">
          <small>Continuation ${i+1} · ${esc(x.role)} · ${fmtDate(x.time)} ${isCurrent(x)?"· current branch":"· alternate branch"}</small>
          <div class="preview">${esc((x.text||"").replace(/\s+/g," ").slice(0,170))}${(x.text||"").length>170?"…":""}</div></button>`:"";}).join("")}
      </div>`;
    }
    body.innerHTML=`<div class="readerMessage">
      <div class="readerHeader"><div><div class="readerWho">${m.role==="user"?"JOYCE":"ASSISTANT"}</div>
      <div class="meta">${fmtDate(m.time)} ${m.model?"· "+esc(m.model):""}</div></div>
      <div class="badges">${sourceBadge(m)}${continuityBadge(a.status)}${a.saved?'<span class="badge saved">SAVED</span>':""}${branchBadge(m)}</div></div>
      <div class="readerText">${esc(m.text||"")}</div>
      <div class="readerNote">${versionBar}
        <div class="readerAnnot">
          <div><label>Continuity</label><select id="readerStatus" onchange="readerSetStatus(this.value)">
            <option value="unmarked" ${a.status==="unmarked"?"selected":""}>Unmarked</option>
            <option value="canon" ${a.status==="canon"?"selected":""}>Canon</option>
            <option value="reference" ${a.status==="reference"?"selected":""}>Reference</option>
            <option value="noncanon" ${a.status==="noncanon"?"selected":""}>Non-canon</option>
          </select><div class="row"><button onclick="readerToggleSaved()">${a.saved?"★ Saved":"☆ Save passage"}</button></div></div>
          <div><label>Archive note</label><textarea id="readerNoteText">${esc(a.note||"")}</textarea>
          <div class="row"><button onclick="readerSaveNote()">Save note</button></div></div>
        </div>${choices}
      </div></div>`;
    $("readerPrev").disabled=!m.prev;
    $("readerNext").disabled=kids.length!==1;
    $("readerNext").textContent=kids.length>1?"Choose continuation ↓":"Next →";
    $("readerPosition").textContent=sibs.length>1?`Version ${idx+1} of ${sibs.length}`:"";
    body.scrollTop=0;
  }catch(e){
    body.innerHTML=`<div class="readerMessage"><div class="readerText">Could not load this generation: ${esc(String(e?.message||e))}</div></div>`;
  }
}
window.openReader=k=>{readerKey=k;$("reader").style.display="block";document.body.style.overflow="hidden";renderReader();};
window.closeReader=()=>{$("reader").style.display="none";document.body.style.overflow="";readerKey=null;};
window.readerPrev=async()=>{const m=await getMessage(readerKey);if(m?.prev)openReader(m.prev);};
window.readerNext=async()=>{const m=await getMessage(readerKey);const kids=m?.next||[];if(kids.length===1)openReader(kids[0]);else if(kids.length>1)document.querySelector(".branchChoices")?.scrollIntoView({behavior:"smooth",block:"center"});};
window.readerSetStatus=v=>{const a=ensureAnno(readerKey);a.status=v;saveAnnotations();toast("Continuity status saved");renderReader();};
window.readerToggleSaved=()=>{const a=ensureAnno(readerKey);a.saved=!a.saved;saveAnnotations();toast(a.saved?"Passage saved":"Passage unsaved");renderReader();};
window.readerSaveNote=()=>{const a=ensureAnno(readerKey);a.note=$("readerNoteText").value;saveAnnotations();toast("Note saved");renderReader();};
window.closeHelp=()=>$("helpModal").style.display="none";

document.addEventListener("keydown",e=>{
  if($("reader").style.display!=="block")return;
  if(e.key==="Escape")closeReader();
  if(e.key==="ArrowLeft" && !["TEXTAREA","INPUT","SELECT"].includes(document.activeElement.tagName))readerPrev();
  if(e.key==="ArrowRight" && !["TEXTAREA","INPUT","SELECT"].includes(document.activeElement.tagName))readerNext();
});

function boot(){
  $("unlockBtn").addEventListener("click",unlockArchive);
  $("vaultPass").addEventListener("keydown",e=>{if(e.key==="Enter")unlockArchive();});
  $("showVaultPass").addEventListener("change",e=>$("vaultPass").type=e.target.checked?"text":"password");
  $("searchBtn").addEventListener("click",runSearch);
  $("q").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();runSearch();}});
  $("titleFilter").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();runSearch();}});
  ["account","continuity","branch","role","mode","sortOrder","savedOnly","includeRecaps"].forEach(id=>$(id).addEventListener("change",()=>{ if(lastSearchRan) $("status").textContent="Filters changed — tap Search archive to refresh results."; }));
  $("helpBtn").addEventListener("click",()=>$("helpModal").style.display="flex");
  $("helpModal").addEventListener("click",e=>{if(e.target.id==="helpModal")closeHelp();});
  $("exportBtn").addEventListener("click",()=>{
    const data={format:"joyce-chat-archive-annotations",version:2,exported_at:new Date().toISOString(),annotations};
    const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");
    a.href=url;a.download=`joyce-archive-annotations-${new Date().toISOString().slice(0,10)}.json`;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);toast("Annotations exported");
  });
  $("importBtn").addEventListener("click",()=>$("importFile").click());
  $("importFile").addEventListener("change",async e=>{
    const file=e.target.files?.[0];if(!file)return;
    try{
      const data=JSON.parse(await file.text()), incoming=data.annotations||data;
      if(!incoming||typeof incoming!=="object"||Array.isArray(incoming))throw new Error("Invalid annotation file");
      let merged=0;
      for(const[k,v]of Object.entries(incoming)){
        if(!v||typeof v!=="object")continue;
        const cur=ensureAnno(k);
        if(v.status&&["unmarked","canon","reference","noncanon"].includes(v.status))cur.status=v.status;
        if(typeof v.saved==="boolean")cur.saved=v.saved;
        if(typeof v.note==="string")cur.note=v.note;
        merged++;
      }
      saveAnnotations();toast(`Imported ${merged} annotation record${merged===1?"":"s"}`);
      if(lastSearchRan)runSearch();
    }catch(err){alert("Couldn't import this annotation file: "+err);}
    e.target.value="";
  });
}
boot();

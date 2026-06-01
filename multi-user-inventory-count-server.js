const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8080;
const DATA_FILE = path.join(__dirname, "multi-user-inventory-count-data.json");

let clients = new Set();
let state = loadState();

function blankState() {
  const now = new Date();
  return {
    session: {
      location: "",
      date: now.toISOString().slice(0, 10),
      time: now.toTimeString().slice(0, 5),
      storeTeam: "",
      financeTeam: "",
    },
    items: [],
    audit: [],
  };
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return blankState();
  }
}

function saveState() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10_000_000) {
        reject(new Error("Request too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
  });
}

function broadcast() {
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const client of clients) client.write(payload);
}

function clean(value) {
  return String(value || "").trim();
}

function number(value) {
  const parsed = Number.parseFloat(String(value || "0").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function variance(item) {
  return item.physicalQty - item.systemQty;
}

function status(item) {
  if (!item.counted) return "pending";
  return variance(item) === 0 ? "matched" : "variance";
}

function audit(action, detail) {
  state.audit.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    at: new Date().toISOString(),
    action,
    ...detail,
  });
  state.audit = state.audit.slice(0, 500);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];

    if (character === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

function normalizeHeader(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function importSheet(csv, user, team) {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error("The uploaded sheet has no item rows.");

  const headers = rows[0].map(normalizeHeader);
  const itemIndex = headers.findIndex((header) => ["itemno", "itemnumber", "item", "sku", "barcode", "qrcode"].includes(header));
  const uomIndex = headers.findIndex((header) => ["uom", "unit", "unitofmeasure"].includes(header));
  const qtyIndex = headers.findIndex((header) => ["qty", "quantity", "systemqty", "systemquantity"].includes(header));
  const descriptionIndex = headers.findIndex((header) => ["description", "desc", "itemdescription", "itemname", "name"].includes(header));

  if (itemIndex === -1 || qtyIndex === -1) {
    throw new Error("CSV must include item no and Qty columns.");
  }

  const previous = new Map(state.items.map((item) => [item.itemNo.toLowerCase(), item]));

  state.items = rows.slice(1).map((row) => {
    const itemNo = clean(row[itemIndex]);
    const existing = previous.get(itemNo.toLowerCase());
    return {
      itemNo,
      description: clean(row[descriptionIndex]) || "-",
      uom: clean(row[uomIndex]) || "-",
      systemQty: number(row[qtyIndex]),
      physicalQty: existing ? existing.physicalQty : 0,
      counted: existing ? existing.counted : false,
      remark: existing ? existing.remark : "",
      lastUpdatedBy: existing ? existing.lastUpdatedBy : "",
      lastUpdatedTeam: existing ? existing.lastUpdatedTeam : "",
      lastUpdatedAt: existing ? existing.lastUpdatedAt : "",
      updates: existing ? existing.updates : [],
    };
  }).filter((item) => item.itemNo);

  audit("upload", { user, team, itemNo: "", quantity: state.items.length, note: "Uploaded system count sheet" });
}

function findItem(itemNo) {
  const code = clean(itemNo).toLowerCase();
  return state.items.find((item) => item.itemNo.toLowerCase() === code);
}

function updateCount({ itemNo, quantity, mode, remark, user, team }) {
  const code = clean(itemNo);
  if (!code) throw new Error("Item number is required.");

  let item = findItem(code);
  if (!item) {
    item = {
      itemNo: code,
      description: "Not found in system count sheet",
      uom: "-",
      systemQty: 0,
      physicalQty: 0,
      counted: false,
      remark: "",
      lastUpdatedBy: "",
      lastUpdatedTeam: "",
      lastUpdatedAt: "",
      updates: [],
    };
    state.items.unshift(item);
  }

  const qty = Math.max(0, number(quantity));
  const previousQty = item.physicalQty;
  const nextQty = mode === "scan" ? previousQty + (qty || 1) : qty;
  const at = new Date().toISOString();

  item.physicalQty = Math.max(0, nextQty);
  item.counted = true;
  if (clean(remark)) item.remark = clean(remark);
  item.lastUpdatedBy = clean(user) || "Unknown user";
  item.lastUpdatedTeam = clean(team) || "No team";
  item.lastUpdatedAt = at;
  item.updates.unshift({
    at,
    user: item.lastUpdatedBy,
    team: item.lastUpdatedTeam,
    previousQty,
    newQty: item.physicalQty,
    mode: mode === "scan" ? "scan" : "manual",
    remark: clean(remark),
  });
  item.updates = item.updates.slice(0, 50);

  audit("count", {
    user: item.lastUpdatedBy,
    team: item.lastUpdatedTeam,
    itemNo: item.itemNo,
    quantity: item.physicalQty,
    variance: variance(item),
    note: item.remark,
  });
}

function csvReport() {
  const rows = [
    ["Item No", "Description", "UoM", "System Qty", "Physical Qty", "Variance", "Status", "Remark", "Last Updated By", "Team", "Last Updated At"],
    ...state.items.map((item) => [
      item.itemNo,
      item.description,
      item.uom,
      item.systemQty,
      item.counted ? item.physicalQty : "",
      item.counted ? variance(item) : "Pending",
      status(item),
      item.remark,
      item.lastUpdatedBy,
      item.lastUpdatedTeam,
      item.lastUpdatedAt,
    ]),
  ];

  return rows.map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
}

const appHtml = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#1f7a5c">
  <title>Team Inventory Count</title>
  <style>
    :root{--bg:#f4f6f1;--panel:#fff;--ink:#1e2420;--muted:#667069;--line:#d9e0dc;--accent:#1f7a5c;--dark:#29332d;--warn:#b25035;--bad:#fff0eb;--ok:#edf8f1;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);-webkit-text-size-adjust:100%}button,input,select,textarea{font:inherit;font-size:16px}
    .app{max-width:1280px;margin:auto;padding:14px}.top{display:grid;gap:12px;margin-bottom:12px}.eyebrow{margin:0;color:var(--accent);font-size:.76rem;font-weight:850;text-transform:uppercase}h1,h2{margin:0}h1{font-size:1.9rem}.summary{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.box,.panel,.row{background:rgba(255,255,255,.94);border:1px solid var(--line);border-radius:8px}.box{padding:10px}.box span{display:block;font-size:1.4rem;font-weight:850}.box small,label span,.hint,.msg{color:var(--muted)}
    .tabs{display:grid;grid-template-columns:1fr;gap:8px;margin-bottom:12px}.tabs button{background:#fff;color:var(--dark);border:1px solid var(--line)}.tabs button.active{background:var(--accent);color:#fff}.panel{display:none;padding:12px;margin-bottom:12px}.panel.active{display:block}.grid{display:grid;gap:10px}.title{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:12px}
    label{display:grid;gap:6px}label span{font-size:.82rem;font-weight:750}input,select,textarea{width:100%;min-height:46px;border:1px solid var(--line);border-radius:7px;padding:0 12px;background:#fff;color:var(--ink)}textarea{min-height:78px;padding-top:10px}button{min-height:46px;border:0;border-radius:7px;background:var(--accent);color:#fff;font-weight:800;padding:0 14px}.secondary{background:var(--dark)}.danger{background:var(--warn)}.msg{font-weight:700;min-height:22px}.scan-card{display:grid;gap:8px;border:1px solid var(--line);border-radius:8px;background:#fff;padding:12px;margin-top:10px}.scan-card div,.row>div,.row>label{display:grid;grid-template-columns:110px 1fr;gap:8px;align-items:center}.scan-card span,.row [data-label]::before{color:var(--muted);font-size:.78rem;font-weight:850}.row [data-label]::before{content:attr(data-label)}.scan-card strong,.item,.desc{overflow-wrap:anywhere}
    .tools{display:grid;gap:10px}.list{display:grid;gap:10px}.row{padding:12px}.item{font-weight:850}.desc{font-weight:700}.num{color:var(--muted);font-weight:700}.badge{display:inline-flex;align-items:center;min-height:30px;border-radius:999px;padding:0 10px;font-size:.78rem;font-weight:850}.matched{background:var(--ok);color:#155b44}.variance{background:var(--bad);color:var(--warn)}.pending{background:#f2f4f7;color:var(--muted)}.audit{display:grid;gap:8px;max-height:380px;overflow:auto}.audit article{border:1px solid var(--line);border-radius:8px;background:#fff;padding:10px}.audit strong{display:block}.camera{display:grid;gap:8px;margin-top:10px}.videoBox{overflow:hidden;border:1px solid var(--line);border-radius:8px;background:#111713}.videoBox video{display:block;width:100%;max-height:320px;object-fit:cover}
    @media(min-width:760px){.top{grid-template-columns:1fr auto;align-items:end}.summary{grid-template-columns:repeat(5,92px)}.tabs{grid-template-columns:repeat(4,1fr)}.setup{grid-template-columns:repeat(3,1fr)}.scanGrid{grid-template-columns:1fr .5fr 1fr auto;align-items:end}.tools{grid-template-columns:1fr 170px auto auto}.scan-card{grid-template-columns:repeat(4,1fr)}.scan-card div{grid-template-columns:1fr}.row{grid-template-columns:1fr 1.3fr 70px 95px 100px 100px 1fr 110px 110px;align-items:center}.row>div,.row>label{display:block}.row [data-label]::before{display:none}}
  </style>
</head>
<body>
  <main class="app">
    <header class="top">
      <div><p class="eyebrow">Shared warehouse count</p><h1>Team Inventory Count</h1></div>
      <div class="summary"><div class="box"><span id="total">0</span><small>items</small></div><div class="box"><span id="counted">0</span><small>counted</small></div><div class="box"><span id="pending">0</span><small>pending</small></div><div class="box"><span id="vars">0</span><small>variance</small></div><div class="box"><span id="online">1</span><small>live</small></div></div>
    </header>
    <nav class="tabs"><button class="active" data-tab="identity">1. User</button><button data-tab="setup">2. Setup</button><button data-tab="scan">3. Scan</button><button data-tab="review">4. Review</button></nav>
    <section class="panel active" data-panel="identity">
      <div class="title"><h2>User / Team</h2></div>
      <div class="grid setup"><label><span>Your name</span><input id="user" placeholder="Counter name"></label><label><span>Team</span><input id="team" placeholder="Team A, Team 7, Finance 2"></label><button id="saveUser">Save user</button></div>
      <p class="msg" id="idMsg"></p>
    </section>
    <section class="panel" data-panel="setup">
      <div class="title"><h2>Count Setup</h2><button id="reset" class="danger">Reset count</button></div>
      <div class="grid setup"><label><span>Location</span><input id="location"></label><label><span>Date</span><input id="date" type="date"></label><label><span>Time</span><input id="time" type="time"></label><label><span>Store team members</span><textarea id="storeTeam"></textarea></label><label><span>Finance team members</span><textarea id="financeTeam"></textarea></label><label><span>System count CSV</span><input id="sheet" type="file" accept=".csv,.txt"><small class="hint">CSV columns: item no, UoM, Qty, Description.</small></label></div>
      <p class="msg" id="setupMsg"></p>
    </section>
    <section class="panel" data-panel="scan">
      <div class="title"><h2>Scan / Count</h2><select id="mode"><option value="manual">Enter quantity</option><option value="scan">Add 1 per scan</option></select></div>
      <form class="grid scanGrid" id="scanForm"><label><span>Item no / barcode / QR</span><input id="code" autocapitalize="off" autocomplete="off"></label><label><span>Qty</span><input id="qty" type="number" min="0" step="1" value="1"></label><label><span>Remark</span><input id="remark"></label><button>Update count</button></form>
      <article class="scan-card" id="card" hidden><div><span>Item no</span><strong id="cItem"></strong></div><div><span>Description</span><strong id="cDesc"></strong></div><div><span>UoM</span><strong id="cUom"></strong></div><div><span>System</span><strong id="cSys"></strong></div><div><span>Physical</span><strong id="cPhy"></strong></div><div><span>Variance</span><strong id="cVar"></strong></div><div><span>Last user</span><strong id="cUser"></strong></div><div><span>Team</span><strong id="cTeam"></strong></div></article>
      <div class="camera"><button id="camera" type="button" class="secondary">Open camera scanner</button><button id="stopCamera" type="button" class="danger" hidden>Stop camera</button><div id="videoBox" class="videoBox" hidden><video id="video" playsinline muted></video></div></div>
      <p class="msg" id="scanMsg"></p>
    </section>
    <section class="panel" data-panel="review">
      <div class="tools"><label><span>Search</span><input id="search" placeholder="Find item, description, user, team"></label><select id="filter"><option value="all">All</option><option value="pending">Pending</option><option value="matched">Matched</option><option value="variance">Variance</option></select><button id="export" class="secondary">Export CSV</button><button id="print" class="secondary">Print / PDF</button></div>
    </section>
    <section id="list" class="list"></section>
    <section class="panel active"><div class="title"><h2>Recent Updates</h2></div><div id="audit" class="audit"></div></section>
  </main>
  <script>
    const $=s=>document.querySelector(s),$$=s=>document.querySelectorAll(s);let state={session:{},items:[],audit:[]},stream=null,timer=null;
    const me={user:localStorage.teamCountUser||"",team:localStorage.teamCountTeam||""};$("#user").value=me.user;$("#team").value=me.team;
    function api(path,data){return fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)}).then(r=>r.json())}
    function tab(n){$$("[data-tab]").forEach(b=>b.classList.toggle("active",b.dataset.tab===n));$$("[data-panel]").forEach(p=>p.classList.toggle("active",p.dataset.panel===n))}
    $$("[data-tab]").forEach(b=>b.onclick=()=>tab(b.dataset.tab));$("#saveUser").onclick=()=>{me.user=$("#user").value.trim();me.team=$("#team").value.trim();localStorage.teamCountUser=me.user;localStorage.teamCountTeam=me.team;$("#idMsg").textContent="Saved. Open Scan to start counting.";tab("scan")};
    function v(i){return i.physicalQty-i.systemQty}function status(i){return !i.counted?"pending":v(i)===0?"matched":"variance"}function fmt(n){return Number(n||0).toLocaleString(void 0,{maximumFractionDigits:2})}function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}function find(c){let x=String(c||"").trim().toLowerCase();return state.items.find(i=>i.itemNo.toLowerCase()===x)}
    function render(){let counted=state.items.filter(i=>i.counted).length,vars=state.items.filter(i=>i.counted&&v(i)!==0).length;$("#total").textContent=state.items.length;$("#counted").textContent=counted;$("#pending").textContent=state.items.length-counted;$("#vars").textContent=vars;["location","date","time","storeTeam","financeTeam"].forEach(k=>{let e=$("#"+k);if(document.activeElement!==e)e.value=state.session[k]||""});let q=$("#search").value.toLowerCase(),f=$("#filter").value,rows=state.items.filter(i=>`${i.itemNo} ${i.description} ${i.uom} ${i.remark} ${i.lastUpdatedBy} ${i.lastUpdatedTeam}`.toLowerCase().includes(q)&&(f==="all"||status(i)===f));$("#list").innerHTML=rows.map(i=>`<article class="row"><div class="item" data-label="Item">${esc(i.itemNo)}</div><div class="desc" data-label="Description">${esc(i.description)}</div><div class="num" data-label="UoM">${esc(i.uom)}</div><div class="num" data-label="System">${fmt(i.systemQty)}</div><div class="num" data-label="Physical">${i.counted?fmt(i.physicalQty):""}</div><div data-label="Variance"><span class="badge ${status(i)}">${!i.counted?"Pending":v(i)===0?"Matched":fmt(v(i))}</span></div><div data-label="Remark">${esc(i.remark)}</div><div data-label="User">${esc(i.lastUpdatedBy)}</div><div data-label="Team">${esc(i.lastUpdatedTeam)}</div></article>`).join("");$("#audit").innerHTML=state.audit.slice(0,30).map(a=>`<article><strong>${esc(a.user||"System")} ${a.team?"/ "+esc(a.team):""}</strong><span>${new Date(a.at).toLocaleString()} - ${esc(a.action)} ${a.itemNo?esc(a.itemNo):""} ${a.quantity!==undefined?"Qty: "+esc(a.quantity):""} ${a.variance!==undefined?"Variance: "+esc(a.variance):""}</span></article>`).join("")}
    function showItem(){let code=$("#code").value.trim(),i=find(code);if(!code){$("#card").hidden=true;return}$("#card").hidden=false;$("#cItem").textContent=code;if(!i){$("#cDesc").textContent="Not found in system count sheet";$("#cUom").textContent="-";$("#cSys").textContent="0";$("#cPhy").textContent="0";$("#cVar").textContent="New item";$("#cUser").textContent="-";$("#cTeam").textContent="-";return}$("#cDesc").textContent=i.description;$("#cUom").textContent=i.uom;$("#cSys").textContent=fmt(i.systemQty);$("#cPhy").textContent=fmt(i.physicalQty);$("#cVar").textContent=!i.counted?"Pending":fmt(v(i));$("#cUser").textContent=i.lastUpdatedBy||"-";$("#cTeam").textContent=i.lastUpdatedTeam||"-"}
    $("#code").oninput=showItem;$("#scanForm").onsubmit=async e=>{e.preventDefault();let result=await api("/api/count",{itemNo:$("#code").value,quantity:$("#qty").value,mode:$("#mode").value,remark:$("#remark").value,user:me.user,team:me.team});$("#scanMsg").textContent=result.ok?"Count updated.":"Update failed: "+result.error;$("#code").value="";$("#remark").value="";$("#card").hidden=true;$("#code").focus()};
    ["location","date","time","storeTeam","financeTeam"].forEach(k=>$("#"+k).onchange=()=>api("/api/session",{session:{[k]:$("#"+k).value},user:me.user,team:me.team}));
    $("#sheet").onchange=async e=>{let file=e.target.files[0];if(!file)return;let csv=await file.text(),result=await api("/api/upload",{csv,user:me.user,team:me.team});$("#setupMsg").textContent=result.ok?"Uploaded. Teams can start scanning.":"Upload failed: "+result.error;if(result.ok)tab("scan")};
    $("#reset").onclick=async()=>{if(confirm("Reset the shared count for everyone?"))await api("/api/reset",{user:me.user,team:me.team})};$("#search").oninput=render;$("#filter").onchange=render;$("#export").onclick=()=>location.href="/api/export.csv";$("#print").onclick=()=>open("/report","_blank");
    async function startCamera(){if(!("BarcodeDetector"in window)||!navigator.mediaDevices?.getUserMedia){$("#scanMsg").textContent="Camera scan needs browser support and usually HTTPS. Manual entry works.";return}try{let detector=new BarcodeDetector({formats:["qr_code","code_128","code_39","ean_13","ean_8","upc_a","upc_e"]});stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}},audio:false});$("#video").srcObject=stream;await $("#video").play();$("#videoBox").hidden=false;$("#stopCamera").hidden=false;$("#camera").hidden=true;timer=setInterval(async()=>{let codes=[];try{codes=await detector.detect($("#video"))}catch{}if(codes.length){$("#code").value=codes[0].rawValue;stopCamera();showItem();$("#qty").focus()}},700)}catch{$("#scanMsg").textContent="Camera could not be opened. Use manual scan/type."}}function stopCamera(){if(timer)clearInterval(timer);timer=null;if(stream)stream.getTracks().forEach(t=>t.stop());stream=null;$("#video").srcObject=null;$("#videoBox").hidden=true;$("#stopCamera").hidden=true;$("#camera").hidden=false}$("#camera").onclick=startCamera;$("#stopCamera").onclick=stopCamera;
    fetch("/api/state").then(r=>r.json()).then(s=>{state=s;render()});new EventSource("/events").onmessage=e=>{state=JSON.parse(e.data);render();showItem()};
  </script>
</body>
</html>`;

function reportHtml() {
  const rows = state.items.map((item) => `
    <tr>
      <td>${escapeHtml(item.itemNo)}</td>
      <td>${escapeHtml(item.description)}</td>
      <td>${escapeHtml(item.uom)}</td>
      <td>${item.systemQty}</td>
      <td>${item.counted ? item.physicalQty : ""}</td>
      <td>${item.counted ? variance(item) : "Pending"}</td>
      <td>${escapeHtml(item.remark)}</td>
      <td>${escapeHtml(item.lastUpdatedBy)}</td>
      <td>${escapeHtml(item.lastUpdatedTeam)}</td>
    </tr>
  `).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Inventory Count Report</title><style>body{font-family:Arial,sans-serif}table{width:100%;border-collapse:collapse}td,th{border:1px solid #999;padding:7px;vertical-align:top}th{background:#29332d;color:#fff}.meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0}.meta div{border:1px solid #ccc;padding:8px}@media print{button{display:none}}</style></head><body><button onclick="print()">Print / Save PDF</button><h1>Inventory Count Report</h1><div class="meta"><div><b>Location</b><br>${escapeHtml(state.session.location || "-")}</div><div><b>Date / Time</b><br>${escapeHtml(state.session.date)} ${escapeHtml(state.session.time)}</div><div><b>Total Items</b><br>${state.items.length}</div><div><b>Variance Items</b><br>${state.items.filter((item) => item.counted && variance(item) !== 0).length}</div></div><table><thead><tr><th>Item No</th><th>Description</th><th>UoM</th><th>System Qty</th><th>Physical Qty</th><th>Variance</th><th>Remark</th><th>User</th><th>Team</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return entities[character];
  });
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" });
      response.end();
      return;
    }

    if (request.url === "/" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(appHtml);
      return;
    }

    if (request.url === "/events" && request.method === "GET") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      response.write(`data: ${JSON.stringify(state)}\n\n`);
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }

    if (request.url === "/api/state" && request.method === "GET") {
      sendJson(response, 200, state);
      return;
    }

    if (request.url === "/api/session" && request.method === "POST") {
      const body = JSON.parse(await readBody(request));
      state.session = { ...state.session, ...body.session };
      audit("session", { user: body.user, team: body.team, note: "Updated count setup" });
      saveState();
      broadcast();
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.url === "/api/upload" && request.method === "POST") {
      const body = JSON.parse(await readBody(request));
      importSheet(body.csv, body.user, body.team);
      saveState();
      broadcast();
      sendJson(response, 200, { ok: true, count: state.items.length });
      return;
    }

    if (request.url === "/api/count" && request.method === "POST") {
      updateCount(JSON.parse(await readBody(request)));
      saveState();
      broadcast();
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.url === "/api/reset" && request.method === "POST") {
      const body = JSON.parse(await readBody(request));
      state = blankState();
      audit("reset", { user: body.user, team: body.team, note: "Reset shared count" });
      saveState();
      broadcast();
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.url === "/api/export.csv" && request.method === "GET") {
      response.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=team-inventory-count.csv",
      });
      response.end(csvReport());
      return;
    }

    if (request.url === "/report" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(reportHtml());
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Team inventory count server running on http://localhost:${PORT}`);
  console.log("Open the same address from phones on the same Wi-Fi using this computer's IP address.");
});

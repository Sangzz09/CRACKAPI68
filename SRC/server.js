const https = require("https");
const http  = require("http");

// ══════════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════════
const URL_HU  = "https://congnghetool.site/68gb-hu.php";
const URL_MD5 = "https://congnghetool.site/68gb-md5.php";
const PORT        = process.env.PORT || 3000;
const HISTORY_MAX = 500;
const SYNC_MS     = 10000; // 10 giây sync 1 lần

const HEADERS_BASE = {
  "Origin":     "https://congnghetool.site",
  "Referer":    "https://congnghetool.site/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
  "Accept":     "application/json, text/plain, */*",
};

// ══════════════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════════════
let history   = [];   // newest → oldest  [{phien,dice,tong,type,raw}]
let lastPhien = null;
let cookieJar = "";   // lưu cookie nếu server trả về

// ══════════════════════════════════════════════════════════════
//  FETCH (tái sử dụng cookie)
// ══════════════════════════════════════════════════════════════
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const headers = { ...HEADERS_BASE };
    if (cookieJar) headers["Cookie"] = cookieJar;

    const req = https.get(url, { headers }, (res) => {
      // Lưu cookie từ server
      const sc = res.headers["set-cookie"];
      if (sc) {
        cookieJar = sc.map(c => c.split(";")[0]).join("; ");
      }
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        const text = raw.trim();
        // Thử parse JSON
        try {
          resolve({ ok: true, json: JSON.parse(text), text, status: res.statusCode });
        } catch {
          resolve({ ok: true, json: null, text, status: res.statusCode });
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(13000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ══════════════════════════════════════════════════════════════
//  PARSE  —  tự động nhận dạng nhiều cấu trúc JSON phổ biến
//
//  Hỗ trợ:
//  • { data:[{id/sid/phien, dice/dices/d1d2d3, result/type...}] }
//  • { list:[...] }
//  • { result:{...} }  (phiên đơn)
//  • Mảng trực tiếp [...]
//  • Text phân cách (csv-like)
// ══════════════════════════════════════════════════════════════
function extractList(json, text) {
  if (!json) return extractFromText(text);

  // Mảng thẳng
  if (Array.isArray(json)) return json;

  // Trường phổ biến chứa mảng
  for (const k of ["data","list","sessions","items","records","history","results","rows"]) {
    if (Array.isArray(json[k])) return json[k];
    if (json[k] && Array.isArray(json[k].list)) return json[k].list;
    if (json[k] && Array.isArray(json[k].data)) return json[k].data;
  }

  // Object đơn → bọc vào mảng
  if (json.id || json.sid || json.phien || json.session_id) return [json];

  // Dữ liệu lồng sâu hơn
  for (const v of Object.values(json)) {
    if (Array.isArray(v) && v.length) return v;
  }
  return [];
}

function extractFromText(text) {
  // Thử tìm JSON array/object bên trong text
  const m = text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (m) { try { const j = JSON.parse(m[1]); return extractList(j, ""); } catch {} }
  // CSV-like: mỗi dòng là 1 phiên
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.startsWith("#"));
  if (lines.length > 1) {
    return lines.map(l => {
      const parts = l.split(/[,|\t]/);
      return { raw_line: l, parts };
    });
  }
  return [];
}

function parseItem(s) {
  if (!s || typeof s !== "object") return null;

  // ── Phiên ──
  const phien = String(
    s.id ?? s.sid ?? s.phien ?? s.session_id ?? s.sessionId ??
    s.issue ?? s.round ?? s.no ?? s.期号 ?? "?"
  );
  if (phien === "?") return null;

  // ── Dice ──
  let dice = null;
  for (const f of ["dices","dice","xuc_xac","xucXac","cubes","cube","bones","values","nums"]) {
    if (Array.isArray(s[f]) && s[f].length >= 3) {
      const d = s[f].slice(0,3).map(Number);
      if (d.every(x => x>=1 && x<=6)) { dice = d; break; }
    }
  }
  if (!dice && s.d1 != null && s.d2 != null && s.d3 != null) {
    const d = [Number(s.d1), Number(s.d2), Number(s.d3)];
    if (d.every(x => x>=1 && x<=6)) dice = d;
  }
  // Thử parse string dạng "3,4,5" hoặc "3 4 5"
  if (!dice) {
    for (const f of ["dice_str","diceStr","result_str","cubeStr"]) {
      if (typeof s[f] === "string") {
        const d = s[f].split(/[,\s]+/).map(Number).filter(x => x>=1&&x<=6);
        if (d.length >= 3) { dice = d.slice(0,3); break; }
      }
    }
  }

  // ── Tổng ──
  const tong = typeof s.point  === "number" ? s.point
             : typeof s.total  === "number" ? s.total
             : typeof s.sum    === "number" ? s.sum
             : typeof s.tong   === "number" ? s.tong
             : typeof s.score  === "number" ? s.score
             : dice ? dice.reduce((a,b)=>a+b,0) : null;

  if (tong == null) return null;

  // ── Kết quả ──
  let type = null;
  const rFields = ["result","type","resultTruyenThong","ket_qua","ketQua",
                   "outcome","winner","side","big_small","bigsmall"];
  for (const f of rFields) {
    if (s[f] == null) continue;
    const r = String(s[f]).toUpperCase().trim();
    if (r.includes("TAI")||r.includes("TÀI")||r==="T"||r==="BIG"||r==="B"||r==="1"||r==="OVER")
      { type="T"; break; }
    if (r.includes("XIU")||r.includes("XỈU")||r.includes("SMALL")||r==="X"||r==="S"||r==="0"||r==="UNDER")
      { type="X"; break; }
  }
  if (!type) type = tong >= 11 ? "T" : "X";

  return { phien, dice: dice??[], tong, type };
}

// ══════════════════════════════════════════════════════════════
//  INGEST
// ══════════════════════════════════════════════════════════════
function ingest(list) {
  const existing = new Set(history.map(h => h.phien));
  let added = 0;
  for (const raw of list) {
    const item = parseItem(raw);
    if (!item || existing.has(item.phien)) continue;
    history.push(item);
    existing.add(item.phien);
    added++;
  }
  history.sort((a,b) => {
    const na = Number(a.phien), nb = Number(b.phien);
    if (!isNaN(na) && !isNaN(nb)) return nb - na;
    return a.phien < b.phien ? 1 : -1;
  });
  if (history.length > HISTORY_MAX) history = history.slice(0, HISTORY_MAX);
  return added;
}

// ══════════════════════════════════════════════════════════════
//  SELF-CALIBRATING WEIGHT
// ══════════════════════════════════════════════════════════════
const ALGOS = [
  "pattern","markov3","markov2","markov1",
  "freq","luong","streak5","entropy",
  "chuky","autocorr","momentum","bayesian",
  "ngram4","reversal","chiSq","trendFollow","streakLen"
];
const acc = {};
for (const n of ALGOS) acc[n] = { c:20, t:40 };

function updateAcc(name, pred, actual) {
  if (!acc[name]) return;
  acc[name].t++;
  if (pred===actual) acc[name].c++;
  if (acc[name].t > 80) { acc[name].c *= 80/acc[name].t; acc[name].t = 80; }
}
function getWeight(name) {
  const a = acc[name]; if (!a||a.t<8) return 1.0;
  const r = a.c/a.t;
  return Math.max(0, (r-0.38)/0.12);
}

let lastPreds = {};
function recordActual(actual) {
  for (const [n,p] of Object.entries(lastPreds)) updateAcc(n,p,actual);
  lastPreds = {};
}

// ══════════════════════════════════════════════════════════════
//  PATTERN DETECTION
// ══════════════════════════════════════════════════════════════
function detectPattern(seq) {
  if (seq.length < 4) return null;
  const s = seq.join("");

  const bm = s.match(/^(T{3,}|X{3,})/);
  if (bm) {
    const len=bm[0].length, same=bm[0][0];
    const next=len>=7?(same==="T"?"X":"T"):same;
    const conf=len>=7?0.70:Math.min(0.54+len*0.03,0.80);
    return {name:`Bệt ${same==="T"?"Tài":"Xỉu"}(${len})`,next,conf};
  }
  let alt=0;
  for(let i=0;i<Math.min(seq.length,12);i++){if(i===0||seq[i]!==seq[i-1])alt++;else break;}
  if(alt>=6) return {name:"Cầu 1-1 dài",next:seq[0]==="T"?"X":"T",conf:0.73};
  if(alt>=4) return {name:"Cầu 1-1",     next:seq[0]==="T"?"X":"T",conf:0.64};

  if(s.length>=8&&s[0]===s[1]&&s[2]===s[3]&&s[0]!==s[2]&&s[4]===s[5]&&s[0]===s[4])
    return {name:"Cầu 2-2",next:s[0],conf:0.68};
  if(s.length>=6&&s[0]!==s[1]&&s[1]===s[2]&&s[3]===s[4]&&s[1]!==s[3])
    return {name:"Cầu 2-2 giữa",next:s[0]==="T"?"X":"T",conf:0.63};
  if(s.length>=6&&s[0]===s[1]&&s[1]===s[2]&&s[3]===s[4]&&s[4]===s[5]&&s[0]!==s[3])
    return {name:"Cầu 3-3",next:s[0],conf:0.65};
  if(s.length>=8&&s.slice(0,4).split("").every(c=>c===s[0])&&
     s.slice(4,8).split("").every(c=>c===s[4])&&s[0]!==s[4])
    return {name:"Cầu 4-4",next:s[0],conf:0.66};
  if(s.length>=6&&s[0]===s[1]&&s[2]!==s[1]&&s[3]===s[4]&&s[5]!==s[4]&&s[0]===s[3])
    return {name:"Cầu 2-1",next:s[0],conf:0.62};
  if(s.length>=6&&s[0]!==s[1]&&s[1]===s[2]&&s[3]!==s[4]&&s[4]===s[5])
    return {name:"Cầu 1-2",next:s[0],conf:0.61};
  for(const p of [2,3,4]){
    if(s.length>=p*3){const c=s.slice(0,p);
      if(s.slice(p,p*2)===c&&s.slice(p*2,p*3)===c)
        return {name:`Chu Kỳ ${p}`,next:c[0],conf:0.65+p*0.01};}
  }
  if(s.length>=5&&s[0]===s[4]&&s[1]===s[3]&&s[1]!==s[0])
    return {name:"Cầu Gương",next:s[1]==="T"?"X":"T",conf:0.60};
  return null;
}

// ══════════════════════════════════════════════════════════════
//  ALGORITHMS
// ══════════════════════════════════════════════════════════════
function algoMarkov3(seq){
  if(seq.length<20)return null;
  const t={};
  for(let i=0;i<seq.length-3;i++){const k=seq[i+3]+seq[i+2]+seq[i+1];if(!t[k])t[k]={T:0,X:0};t[k][seq[i]]++;}
  const k=seq[2]+seq[1]+seq[0],row=t[k];if(!row)return null;
  const tot=row.T+row.X;if(tot<5)return null;
  if(row.T>row.X)return{next:"T",conf:0.50+(row.T/tot-0.50)*0.68};
  if(row.X>row.T)return{next:"X",conf:0.50+(row.X/tot-0.50)*0.68};
  return null;
}
function algoMarkov2(seq){
  if(seq.length<15)return null;
  const t={};
  for(let i=0;i<seq.length-2;i++){const k=seq[i+2]+seq[i+1];if(!t[k])t[k]={T:0,X:0};t[k][seq[i]]++;}
  const k=seq[1]+seq[0],row=t[k];if(!row)return null;
  const tot=row.T+row.X;if(tot<6)return null;
  if(row.T>row.X)return{next:"T",conf:0.50+(row.T/tot-0.50)*0.70};
  if(row.X>row.T)return{next:"X",conf:0.50+(row.X/tot-0.50)*0.70};
  return null;
}
function algoMarkov1(seq){
  if(seq.length<10)return null;
  const t={T:{T:0,X:0},X:{T:0,X:0}};
  for(let i=0;i<seq.length-1;i++)t[seq[i+1]][seq[i]]++;
  const row=t[seq[0]],tot=row.T+row.X;if(tot<6)return null;
  if(row.T>row.X)return{next:"T",conf:0.50+(row.T/tot-0.50)*0.65};
  if(row.X>row.T)return{next:"X",conf:0.50+(row.X/tot-0.50)*0.65};
  return null;
}
function algoFreq(seq){
  const n20=Math.min(seq.length,20),n50=Math.min(seq.length,50);
  const rT=seq.slice(0,n20).filter(x=>x==="T").length/n20*0.6
           +seq.slice(0,n50).filter(x=>x==="T").length/n50*0.4;
  const rX=1-rT;
  if(rT>0.60)return{next:"X",conf:0.50+(rT-0.50)*0.60};
  if(rX>0.60)return{next:"T",conf:0.50+(rX-0.50)*0.60};
  return null;
}
function algoLuong(seq){
  if(seq.length<8)return null;
  const w=seq.slice(0,8);let tr=0;
  for(let i=1;i<w.length;i++)if(w[i]!==w[i-1])tr++;
  if(tr<=1)return{next:w[0],conf:0.64};
  if(tr>=7)return{next:w[0]==="T"?"X":"T",conf:0.64};
  return null;
}
function algoStreak5(seq){
  if(seq.length<5)return null;
  if(seq.slice(0,5).every(x=>x===seq[0]))return{next:seq[0]==="T"?"X":"T",conf:0.67};
  return null;
}
function algoEntropy(seq){
  const n=Math.min(seq.length,20),sub=seq.slice(0,n);
  let tr=0;for(let i=1;i<sub.length;i++)if(sub[i]!==sub[i-1])tr++;
  const e=tr/(n-1);
  if(e>0.38&&e<0.62)return null;
  if(e<=0.38)return{next:sub[0],conf:0.61};
  return{next:sub[0]==="T"?"X":"T",conf:0.59};
}
function algoChuKy(seq){
  if(seq.length<12)return null;
  for(let p=2;p<=6;p++){
    let match=0,tot=0;
    for(let i=0;i<Math.min(seq.length-p,20);i++){if(seq[i+p]!==undefined){tot++;if(seq[i]===seq[i+p])match++;}}
    if(tot>=6&&match/tot>=0.75)return{next:seq[p-1]??seq[0],conf:0.56+(match/tot-0.75)*0.5};
  }
  return null;
}
function algoAutoCorr(seq){
  if(seq.length<20)return null;
  const n=Math.min(seq.length,40),v=seq.slice(0,n).map(x=>x==="T"?1:0);
  const mean=v.reduce((a,b)=>a+b,0)/n;
  let ac1=0,denom=0;
  for(let i=0;i<n;i++)denom+=(v[i]-mean)**2;
  for(let i=1;i<n;i++)ac1+=(v[i]-mean)*(v[i-1]-mean);
  ac1/=denom;
  if(ac1>0.15)return{next:seq[0],conf:0.54+Math.min(ac1*0.4,0.10)};
  if(ac1<-0.15)return{next:seq[0]==="T"?"X":"T",conf:0.54+Math.min(-ac1*0.4,0.10)};
  return null;
}
function algoMomentum(seq){
  if(seq.length<30)return null;
  const s=seq.slice(0,5).filter(x=>x==="T").length/5;
  const l=seq.slice(0,20).filter(x=>x==="T").length/20;
  const d=s-l;
  if(d>0.25)return{next:"T",conf:0.55+Math.min(d*0.3,0.08)};
  if(d<-0.25)return{next:"X",conf:0.55+Math.min(-d*0.3,0.08)};
  return null;
}
function algoBayesian(seq){
  if(seq.length<15)return null;
  let logOdds=0;
  for(const w of [3,5,8,13]){
    const sub=seq.slice(0,Math.min(w,seq.length));
    const pT=(sub.filter(x=>x==="T").length+1)/(sub.length+2);
    logOdds+=Math.log(pT/(1-pT))/4;
  }
  const pT=1/(1+Math.exp(-logOdds));
  if(pT>0.58)return{next:"T",conf:0.50+(pT-0.50)*0.8};
  if(pT<0.42)return{next:"X",conf:0.50+(0.50-pT)*0.8};
  return null;
}
function algoNgram4(seq){
  if(seq.length<25)return null;
  const t={};
  for(let i=0;i<seq.length-4;i++){const k=seq[i+4]+seq[i+3]+seq[i+2]+seq[i+1];if(!t[k])t[k]={T:0,X:0};t[k][seq[i]]++;}
  const k=seq[3]+seq[2]+seq[1]+seq[0],row=t[k];if(!row)return null;
  const tot=row.T+row.X;if(tot<4)return null;
  if(row.T>row.X)return{next:"T",conf:0.50+(row.T/tot-0.50)*0.72};
  if(row.X>row.T)return{next:"X",conf:0.50+(row.X/tot-0.50)*0.72};
  return null;
}
function algoReversal(seq){
  if(seq.length<20)return null;
  let sLen=1;while(sLen<seq.length&&seq[sLen]===seq[0])sLen++;
  if(sLen<2)return null;
  let rev=0,samp=0;
  for(let i=sLen;i<seq.length-sLen;i++){
    if(seq.slice(i,i+sLen).every(x=>x===seq[i])){samp++;if(seq[i-1]!==seq[i])rev++;i+=sLen-1;}
  }
  if(samp<3)return null;
  const pr=rev/samp;
  if(pr>0.65)return{next:seq[0]==="T"?"X":"T",conf:0.52+pr*0.10};
  if(pr<0.35)return{next:seq[0],conf:0.52+(1-pr)*0.10};
  return null;
}
function algoChiSq(seq){
  if(seq.length<30)return null;
  const obs={TT:0,TX:0,XT:0,XX:0};
  for(let i=0;i<seq.length-1;i++){const k=seq[i+1]+seq[i];if(obs[k]!==undefined)obs[k]++;}
  const n=Object.values(obs).reduce((a,b)=>a+b,0),exp=n/4;
  const chi2=Object.values(obs).reduce((s,o)=>s+(o-exp)**2/exp,0);
  if(chi2<3.84)return null;
  const pTT=obs.TT/(obs.TT+obs.TX+0.001),pXX=obs.XX/(obs.XX+obs.XT+0.001);
  if(seq[0]==="T"&&pTT>0.60)return{next:"T",conf:0.52+pTT*0.10};
  if(seq[0]==="T"&&pTT<0.40)return{next:"X",conf:0.52+(1-pTT)*0.10};
  if(seq[0]==="X"&&pXX>0.60)return{next:"X",conf:0.52+pXX*0.10};
  if(seq[0]==="X"&&pXX<0.40)return{next:"T",conf:0.52+(1-pXX)*0.10};
  return null;
}
function algoTrendFollow(seq){
  if(seq.length<12)return null;
  const v=seq.slice(0,20).map(x=>x==="T"?1:0);
  const ema=(arr,a)=>arr.reduce((e,x,i)=>i===0?x:a*x+(1-a)*e,arr[0]);
  const e5=ema(v.slice(0,5),0.4),e12=ema(v.slice(0,12),0.2);
  if(e5>e12+0.08)return{next:"T",conf:0.55};
  if(e5<e12-0.08)return{next:"X",conf:0.55};
  return null;
}
function algoStreakLen(seq){
  if(seq.length<20)return null;
  const streaks=[];let cur=1;
  for(let i=1;i<seq.length;i++){if(seq[i]===seq[i-1])cur++;else{streaks.push(cur);cur=1;}}
  streaks.push(cur);if(streaks.length<4)return null;
  const avg=streaks.reduce((a,b)=>a+b,0)/streaks.length;
  let curLen=1;while(curLen<seq.length&&seq[curLen]===seq[0])curLen++;
  if(curLen>=Math.ceil(avg*1.5))return{next:seq[0]==="T"?"X":"T",conf:0.57};
  if(curLen===1&&curLen<avg*0.6)return{next:seq[0],conf:0.54};
  return null;
}

// ══════════════════════════════════════════════════════════════
//  ENSEMBLE — 1 phiên tiếp theo
// ══════════════════════════════════════════════════════════════
function predict(hist) {
  if (hist.length < 5) return {
    next:"?",conf:0,cauType:"Chưa đủ dữ liệu",pattern:"",votesT:0,votesX:0,detail:{}
  };
  const seq  = hist.map(h => h.type);
  const wSum = {T:0,X:0};
  const detail={},votes=[];

  const add=(name,res,base)=>{
    if(!res){detail[name]=null;return;}
    lastPreds[name]=res.next;
    const w=base*getWeight(name);
    wSum[res.next]+=res.conf*w;
    detail[name]={next:res.next,conf:Math.round(res.conf*100),w:Math.round(w*100)/100};
    votes.push({pred:res.next});
  };

  const pat=detectPattern(seq);
  add("pattern",     pat,                   5.0);
  add("markov3",     algoMarkov3(seq),      3.5);
  add("markov2",     algoMarkov2(seq),      3.0);
  add("markov1",     algoMarkov1(seq),      2.5);
  add("ngram4",      algoNgram4(seq),       2.5);
  add("bayesian",    algoBayesian(seq),     2.0);
  add("streak5",     algoStreak5(seq),      2.0);
  add("autocorr",    algoAutoCorr(seq),     1.8);
  add("chiSq",       algoChiSq(seq),        1.8);
  add("luong",       algoLuong(seq),        1.5);
  add("momentum",    algoMomentum(seq),     1.5);
  add("freq",        algoFreq(seq),         1.5);
  add("trendFollow", algoTrendFollow(seq),  1.2);
  add("chuky",       algoChuKy(seq),        1.2);
  add("entropy",     algoEntropy(seq),      1.0);
  add("reversal",    algoReversal(seq),     1.0);
  add("streakLen",   algoStreakLen(seq),    1.0);

  const tot=wSum.T+wSum.X;
  let next="T",conf=0.50;
  if(tot>0){
    if(wSum.X>wSum.T){next="X";conf=wSum.X/tot;}
    else              {next="T";conf=wSum.T/tot;}
  }
  conf=Math.min(Math.max(conf,0.50),0.90);

  const patStr =seq.slice(0,16).join("");
  const cauType=pat?pat.name
    :wSum.T>wSum.X?"Nghiêng Tài"
    :wSum.X>wSum.T?"Nghiêng Xỉu":"Cân Bằng";

  return {
    next:    next==="T"?"Tài":"Xỉu",
    raw:     next,
    conf:    Math.round(conf*100),
    cauType, pattern:patStr,
    votesT:  votes.filter(v=>v.pred==="T").length,
    votesX:  votes.filter(v=>v.pred==="X").length,
    detail
  };
}

// ══════════════════════════════════════════════════════════════
//  SYNC — lấy cả 2 endpoint, merge
// ══════════════════════════════════════════════════════════════
let lastDebugHU  = null;
let lastDebugMD5 = null;
let syncError    = null;

async function syncHistory() {
  try {
    // Fetch song song 2 endpoint
    const [resHU, resMD5] = await Promise.allSettled([
      fetchUrl(URL_HU),
      fetchUrl(URL_MD5),
    ]);

    let totalAdded = 0;
    const prevTop  = history[0]?.phien;

    if (resHU.status === "fulfilled") {
      const r = resHU.value;
      lastDebugHU = { status: r.status, text_preview: r.text?.slice(0,300) };
      const list = extractList(r.json, r.text);
      if (list.length) totalAdded += ingest(list);
    }
    if (resMD5.status === "fulfilled") {
      const r = resMD5.value;
      lastDebugMD5 = { status: r.status, text_preview: r.text?.slice(0,300) };
      const list = extractList(r.json, r.text);
      if (list.length) totalAdded += ingest(list);
    }

    // Phiên mới → cập nhật accuracy
    const afterTop = history[0]?.phien;
    if (prevTop && afterTop !== prevTop && history.length >= 2) {
      recordActual(history[1].type);
    }
    lastPhien  = history[0]?.phien ?? null;
    syncError  = null;
  } catch(e) {
    syncError = e.message;
  }
}

// ══════════════════════════════════════════════════════════════
//  HTTP SERVER
// ══════════════════════════════════════════════════════════════
http.createServer(async (req, res) => {
  res.setHeader("Content-Type","application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin","*");
  if (req.method==="OPTIONS"){res.writeHead(204);res.end();return;}

  const url = new URL(req.url, "http://localhost");

  // ── / hoặc /predict ──────────────────────────────────────
  if (url.pathname==="/"||url.pathname==="/predict") {
    await syncHistory();
    if (!history.length) {
      res.writeHead(503);
      res.end(JSON.stringify({error:"Chưa có dữ liệu",sync_error:syncError}));
      return;
    }
    const h    = history[0];
    const pred = predict(history);
    res.writeHead(200);
    res.end(JSON.stringify({
      phien_hien_tai:  h.phien,
      xuc_xac:         h.dice,
      tong:            h.tong,
      ket_qua_hien:    h.type==="T"?"Tài":"Xỉu",
      phien_tiep_theo: String(Number(h.phien)+1),
      du_doan:         pred.next,
      do_tin_cay:      pred.conf+"%",
      loai_cau:        pred.cauType,
      pattern_16:      pred.pattern,
      phieu_Tai:       pred.votesT,
      phieu_Xiu:       pred.votesX,
      lich_su_count:   history.length
    }));
    return;
  }

  // ── /predict/detail ──────────────────────────────────────
  if (url.pathname==="/predict/detail") {
    await syncHistory();
    if (!history.length){res.writeHead(503);res.end(JSON.stringify({error:"Chưa có dữ liệu"}));return;}
    const pred=predict(history);
    res.writeHead(200);
    res.end(JSON.stringify({
      du_doan:       pred.next,
      do_tin_cay:    pred.conf+"%",
      loai_cau:      pred.cauType,
      phieu_Tai:     pred.votesT,
      phieu_Xiu:     pred.votesX,
      chi_tiet_algo: pred.detail
    }));
    return;
  }

  // ── /history ─────────────────────────────────────────────
  if (url.pathname==="/history") {
    await syncHistory();
    const lim=Math.min(parseInt(url.searchParams.get("limit")||"20"),200);
    res.writeHead(200);
    res.end(JSON.stringify({
      total: history.length,
      data:  history.slice(0,lim).map(h=>({
        phien:   h.phien,
        xuc_xac: h.dice,
        tong:    h.tong,
        ket_qua: h.type==="T"?"Tài":"Xỉu"
      }))
    }));
    return;
  }

  // ── /pattern ─────────────────────────────────────────────
  if (url.pathname==="/pattern") {
    await syncHistory();
    if (!history.length){res.writeHead(503);res.end(JSON.stringify({error:"Chưa có dữ liệu"}));return;}
    const seq=history.map(h=>h.type);
    const pat=detectPattern(seq);
    const streaks=[];let cur={v:seq[0],len:1};
    for(let i=1;i<Math.min(seq.length,30);i++){
      if(seq[i]===cur.v)cur.len++;
      else{streaks.push({...cur});cur={v:seq[i],len:1};}
    }
    streaks.push(cur);
    res.writeHead(200);
    res.end(JSON.stringify({
      pattern_20:     seq.slice(0,20).join(""),
      cau_hien_tai:   pat?pat.name:"Không rõ cầu",
      do_tin_cay_cau: pat?Math.round(pat.conf*100)+"%":"N/A",
      chuoi_gan:      streaks.slice(0,8).map(s=>({
        ket_qua:  s.v==="T"?"Tài":"Xỉu",
        so_phien: s.len
      }))
    }));
    return;
  }

  // ── /stats ───────────────────────────────────────────────
  if (url.pathname==="/stats") {
    const out={};
    for(const n of ALGOS){
      const a=acc[n];
      out[n]={
        do_chinh_xac: a.t?Math.round(a.c/a.t*100)+"%":"N/A",
        trong_so:     Math.round(getWeight(n)*100)/100,
        mau:          Math.round(a.t)
      };
    }
    res.writeHead(200);
    res.end(JSON.stringify({algo_stats:out,history_count:history.length}));
    return;
  }

  // ── /debug ───────────────────────────────────────────────
  if (url.pathname==="/debug") {
    await syncHistory();
    res.writeHead(200);
    res.end(JSON.stringify({
      source_hu:   URL_HU,
      source_md5:  URL_MD5,
      last_hu:     lastDebugHU,
      last_md5:    lastDebugMD5,
      cookie_jar:  cookieJar||"(trống)",
      history_count: history.length,
      last_phien:  lastPhien,
      sync_error:  syncError,
      sample_3:    history.slice(0,3)
    },null,2));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({
    error:"Not found",
    endpoints:["/predict","/predict/detail","/history","/pattern","/stats","/debug"]
  }));

}).listen(PORT,()=>{
  console.log("✅ Server running — port "+PORT);
  console.log("   HU  : "+URL_HU);
  console.log("   MD5 : "+URL_MD5);
  syncHistory();
  setInterval(syncHistory, SYNC_MS);
});

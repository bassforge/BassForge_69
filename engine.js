// BassForge — engine.js
// All calculation functions, renderers, UI logic.

/* ═══ AMP LOOKUP ═══ */
function getAmpRMS(brandKey, modelName, ohms) {
  var brand = AMP_DB[brandKey];
  if (!brand) return null;
  var amp = brand.find(function(a){ return a.model === modelName; });
  if (!amp) return null;
  if (ohms === 1) return amp.rms_1ohm;
  if (ohms === 2) return amp.rms_2ohm;
  if (ohms === 4) return amp.rms_4ohm;
  return null;
}

// DEBOUNCE UTILITY — prevents calc firing on every keystroke
function debounce(fn, delay) {
  let timer;
  return function() {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, arguments), delay);
  };
}
// Debounced versions of heavy calc functions (300ms delay)
const elecRunD  = debounce(() => elecRun(),  300);
const sysRunD   = debounce(() => sysRun(),   300);
const clipRunD  = debounce(() => clipRun(),  300);
const splRunD   = debounce(() => splRun(),   300);
const cutsRunD  = debounce(() => cutsRun(),  300);

// TS BOX MATH ENGINE v2.8 (fixed)
const TS = {

  // Sealed box optimal volume — Butterworth (Qtc=0.707) or custom
  sealedVol(qts, vas, qtc) {
    qtc = qtc || 0.707;
    const ratio = qtc / qts;
    const vb = vas / (ratio * ratio - 1);
    return vb > 0 ? +(vb / 28.317).toFixed(3) : null; // L to ft3
  },

  // F3 for sealed box
  sealedF3(fs, qts, vas, vbFt3) {
    const vbL = vbFt3 * 28.317;
    const ratio = Math.sqrt(vas / vbL + 1);
    const qtc = qts * ratio;
    const f3 = fs * ratio * Math.sqrt(
      (1/(2*qtc*qtc)) + Math.sqrt(1/(4*Math.pow(qtc,4)) + 1) - (1/(2*qtc*qtc))
    );
    return +f3.toFixed(1);
  },

  // Ported optimal volume (Thiele alignment)
  portedVol(qts, vas) {
    const vbL = 20 * Math.pow(qts, 3.3) * vas;
    return +(vbL / 28.317).toFixed(3);
  },

  // Optimal ported tuning
  portedFb(fs, qts) {
    return +(fs * Math.pow(0.42 / qts, 0.9)).toFixed(1);
  },

  // Excursion % of Xmax — calibrated ported box model
  // Uses proper ported unloading: port handles ~80% of displacement at Fb
  // Worst case for musical content is ~0.85*Fb (just above subsonic filter)
  excursionPct(rmsW, re, xmaxMM, sd, mmsG, bl, vbFt3, fb, qty) {
    if (!xmaxMM || !sd || !bl || !mmsG) return null;

    // Per-sub power
    const perSubW = rmsW / qty;

    // Peak coil current
    const Ipeak = Math.sqrt(2 * perSubW / re);

    // Peak mechanical force (N)
    const Fpeak = bl * Ipeak;

    // Mms in kg
    const mmsKg = mmsG / 1000;

    // Musical worst case: ~0.85*Fb (just above typical subsonic filter)
    // At this frequency ported box reduces cone excursion by ~80% vs free air
    const worstFreq  = fb * 0.85;
    const omegaWorst = 2 * Math.PI * worstFreq;
    const portFactor = 0.20; // ported box: port handles ~80% of displacement here

    // Peak cone displacement (mm)
    const xPeakMM = (Fpeak / (mmsKg * omegaWorst * omegaWorst)) * portFactor * 1000;

    const pct = (xPeakMM / xmaxMM) * 100;
    return +Math.min(pct, 200).toFixed(0);
  },

  // Thermal load — per sub, not total system
  // rmsW = total amp RMS, pe = single sub Pe rating, qty = number of subs
  thermalPct(rmsW, pe, qty) {
    if (!pe || !qty) return null;
    const perSubW = rmsW / qty;
    return +((perSubW / pe) * 100).toFixed(0);
  },

  // Longevity score 0-100
  longevity(excPct, thermalPct, velPct) {
    if (excPct === null) return null;
    let score = 100;
    // Excursion (most critical)
    if      (excPct > 150) score -= 55;
    else if (excPct > 120) score -= 35;
    else if (excPct > 100) score -= 20;
    else if (excPct > 80)  score -= 10;
    else if (excPct > 60)  score -= 3;
    // Thermal
    if (thermalPct !== null) {
      if      (thermalPct > 120) score -= 25;
      else if (thermalPct > 100) score -= 15;
      else if (thermalPct > 80)  score -= 6;
      else if (thermalPct > 60)  score -= 2;
    }
    // Port velocity
    if      (velPct > 100) score -= 15;
    else if (velPct > 80)  score -= 5;
    return Math.max(0, Math.round(score));
  },

  // Human-readable advice
  advice(excPct, thermalPct, velPct) {
    const tips = [];
    if      (excPct > 120) tips.push('Cone exceeding Xmax — reduce power or add subsonic filter');
    else if (excPct > 100) tips.push('At Xmax limit — add subsonic filter around ' + Math.round(0.7 * 36) + ' Hz');
    else if (excPct > 80)  tips.push('Approaching Xmax — monitor at high volume, consider subsonic filter');
    if      (thermalPct > 120) tips.push('Power exceeds thermal rating — voice coil burnout risk');
    else if (thermalPct > 100) tips.push('At thermal limit — ensure clean signal, no clipping');
    else if (thermalPct > 80)  tips.push('Near thermal limit — avoid extended high-power sessions');
    if      (velPct > 100) tips.push('Port chuffing likely — widen port or lower tuning frequency');
    else if (velPct > 80)  tips.push('Port velocity high — watch for noise at max volume');
    if (tips.length === 0) tips.push('System is in a healthy operating range');
    if (excPct <= 60 && (thermalPct === null || thermalPct <= 60)) tips.push('Plenty of headroom — this build will last');
    return tips;
  }
};

/* ═══ BASSFORGE MASTER ENGINE v24.0 ═══ */
const BF={
  cfg:{
    spd:13504, V:14.4, eff:0.82,
    R:{'4/0':0.0000393,'2/0':0.0000618,'1/0':0.0000981,'2AWG':0.0001568,'4AWG':0.0002485,'8AWG':0.0006282},
    maxA:{'4/0':500,'2/0':400,'1/0':300,'2AWG':200,'4AWG':125,'8AWG':60},
  },

  // MODULE 1 — accepts portType key for proper end correction
  box(dims,sub,qty,port,veh,wood,brace,portType){
    const t=wood,iW=dims.w-t*2,iH=dims.h-t*2,iD=dims.d-t*2;
    if(iW<=0||iH<=0||iD<=0)return null;
    const vdb=VDB[veh]||VDB.standard;
    let inIn3=iW*iH*iD-vdb.hump;
    if(inIn3<=0)return null;
    const gross=inIn3/1728;
    const portH=(port.h&&port.h>0)?Math.min(port.h,iH):iH;
    const pA=port.w*portH;
    const pDsp=(pA*port.len)/1728,sDsp=sub.disp*qty;
    const netPre=gross-sDsp-pDsp;
    const net=netPre*(1-brace); // PATCH 4
    if(net<=0)return null;
    const nIn=net*1728;
    const pt=PORT_LIB[portType]||PORT_LIB.slot;
    const Leff=port.len+(pt.endCorr*Math.sqrt(pA)); // uses port library end correction
    const fb=(this.cfg.spd/(2*Math.PI))*Math.sqrt(pA/(nIn*Leff));
    const vel=(Math.sqrt(sub.rms*qty)*12.8)/pA; // PATCH 2
    return{gross:+gross.toFixed(4),net:+net.toFixed(4),pA:+pA.toFixed(2),
           pDsp:+pDsp.toFixed(4),sDsp:+sDsp.toFixed(4),
           fb:+fb.toFixed(1),vel:+vel.toFixed(1),
           iW:+iW.toFixed(2),iH:+iH.toFixed(2),iD:+iD.toFixed(2),
           portType:portType||'slot',ptName:pt.name};
  },

  // MODULE 2
  wire(qty,opc,isDVC,cm,sm){
    let ss=isDVC?(cm==='parallel'?opc/2:opc*2):opc;
    let fl=sm==='parallel'?ss/qty:ss*qty;
    const r=fl<1?'unstable':fl<2?'risky':fl<=2?'good':'conservative';
    return{ss:+ss.toFixed(2),fl:+fl.toFixed(2),rating:r};
  },

  // MODULE 3 — PATCH 1: round-trip ×2 | v23: amp class efficiency
  elec(rms,gauge,len,alt,base,ampEff,big3_upgrade){
    const V=this.cfg.V;
    const eff=ampEff||this.cfg.eff; // v23: use passed efficiency or default
    const R=this.cfg.R[gauge]||0.0000981;
    const mA=this.cfg.maxA[gauge]||300;
    // v4.1: Amps = (Watts/Eff)/Volts. Big 3 = 30% less resistance penalty.
    const draw=(rms/eff)/V;
    const heatW=rms*(1-eff);
    const resFactor=big3_upgrade?0.70:1.0;
    let vd=draw*R*len*2*resFactor;
    const vFloor=big3_upgrade?13.2:12.6;
    const tv=Math.max(vFloor,V-vd);
    const ap=rms*Math.pow(tv/V,2);
    const fuse=Math.ceil((draw*1.25)/5)*5;
    const td=draw+base,am=alt-td;
    return{draw:+draw.toFixed(1),vd:+vd.toFixed(3),tv:+tv.toFixed(2),
           ap:+ap.toFixed(0),fuse,am:+am.toFixed(1),td:+td.toFixed(1),
           wlp:+(draw/mA*100).toFixed(0),mA,heatW:+heatW.toFixed(0),eff:+(eff*100).toFixed(0)};
  },

  // SPL with compression penalty [v22]
  spl(sens,rms,n,cabin,vel,mode){
    const pg=10*Math.log10(rms);
    const sg=3*Math.log2(n);
    const cl=vel<17?0:vel<22?1:vel<27?2:3.5;
    const mb=mode==='comp'?2:mode==='spl'?1:0;
    const spl=sens+pg+sg+cabin-cl+mb;
    return{spl:+spl.toFixed(1),pg:+pg.toFixed(1),sg:+sg.toFixed(1),cl,mb};
  },

  // AUTO-FORGE SOLVER [v22]
  autoForge(tVol,tTune,pW,wood,veh,sDsp,qty,sRms){
    const vdb=VDB[veh]||VDB.standard;
    const step=0.25,t=wood;
    const maxW=vdb.maxW||72,maxH=vdb.maxH||16,maxD=vdb.maxD||24;
    let best=null,bestDiff=999;
    for(let w=12;w<=maxW;w+=step){
      const iH=maxH-t*2,iD=maxD-t*2,iW=w-t*2;
      if(iW<=2||iH<=2||iD<=2)continue;
      const pA=pW*iH;
      const gross=(iW*iH*iD)/1728;
      const netEst=(gross-sDsp*qty-(pA*12)/1728)*0.97;
      if(netEst<=0.1)continue;
      const Lv=(1.463e7*pA)/(tTune*tTune*(netEst*1728))-1.463*Math.sqrt(pA);
      if(Lv<1||Lv>72)continue;
      const r=this.box({w,h:maxH,d:maxD},{disp:sDsp,rms:sRms},qty,{w:pW,len:Lv},veh,t,0.03);
      if(!r)continue;
      const diff=Math.abs(r.net-tVol);
      if(diff<bestDiff){bestDiff=diff;best={width:+w.toFixed(2),height:maxH,depth:maxD,net:+r.net.toFixed(3),fb:r.fb,vel:r.vel,pLen:+Lv.toFixed(2),pA:+pA.toFixed(2),veh:vdb.name};}
      if(diff<0.08)break;
    }
    return best ? {...best, fitWarning: bestDiff>=0.5 ? 'Closest fit is '+bestDiff.toFixed(2)+' ft³ off target. Try adjusting volume or port width.' : null} : null;
  },

  // CUT SHEET [v22]
  cuts(dims,t,db,ns){
    const iH=dims.h-t*2,iD=dims.d-t*2;
    const panels=[
      {name:'Top Panel',    w:dims.w,d:dims.d,qty:1},
      {name:'Bottom Panel', w:dims.w,d:dims.d,qty:1},
      {name:'Front Baffle', w:dims.w,d:iH,    qty:db?2:1,note:`${ns} sub hole${ns>1?'s':''}${db?' — DBL BAFFLE':''}`},
      {name:'Back Panel',   w:dims.w,d:iH,    qty:1},
      {name:'Side Panels',  w:iD,    d:iH,    qty:2},
      {name:'Port Divider', w:3,     d:iH,    qty:1,green:true},
    ];
    const totalA=panels.reduce((a,p)=>a+p.w*p.d*p.qty,0);
    const sheets=Math.ceil((totalA/(48*96))*1.22);
    return{panels,totalA:+totalA.toFixed(0),sheets};
  },

  // MASTER AUDIT
  audit(inp){
    const b=this.box(inp.dims,inp.sub,inp.qty,inp.port,inp.veh,inp.wood,inp.brace,inp.portType);
    const w=this.wire(inp.qty,inp.sub.ohms,inp.sub.isDVC,inp.cm,inp.sm);
    const e=this.elec(inp.rms,inp.gauge,inp.len,inp.alt,inp.base);
    const vdb=VDB[inp.veh]||VDB.standard;
    const cabinGain=inp.cabin||vdb.cabinGain||7;
    const s=this.spl(inp.sens,inp.rms,inp.qty,cabinGain,b?b.vel:0,'daily');
    let rpts=[],health=100;

    if(b){
      const pt=PORT_LIB[b.portType]||PORT_LIB.slot;
      if(b.vel>pt.maxVel){
        rpts.push({cls:'bad',msg:`🔊 PORT NOISE: ${b.vel} m/s exceeds ${pt.name} limit (${pt.maxVel} m/s). Switch to Aeroport or widen slot by 0.75".`});
        health-=20;
      } else if(b.vel>pt.warnVel){
        rpts.push({cls:'warn',msg:`⚠️ PORT FLOW: ${b.vel} m/s — approaching ${pt.name} limit. Widen port for headroom.`});
        health-=8;
      } else {
        rpts.push({cls:'ok',msg:`✅ PORT FLOW: ${b.vel} m/s — laminar flow. ${pt.name} running clean.`});
      }
      if(b.fb<28)rpts.push({cls:'info',msg:`🎵 TUNE: ${b.fb} Hz — deep SQ.`});
      else if(b.fb>42)rpts.push({cls:'warn',msg:`⚠️ TUNE: ${b.fb} Hz — SPL/comp. May thin out daily bass.`});
      else rpts.push({cls:'ok',msg:`✅ TUNE: ${b.fb} Hz — solid daily/SPL range.`});
      if(b.net<=0.3){rpts.push({cls:'bad',msg:'❌ VOLUME critically low. Increase box size.'});health-=25;}
    }else{rpts.push({cls:'bad',msg:'❌ ENCLOSURE: Invalid dimensions.'});health-=30;}

    if(w.fl<1){rpts.push({cls:'bad',msg:`❌ IMPEDANCE: ${w.fl}Ω — amp failure risk below 1Ω.`});health-=25;}
    else if(w.fl<2){rpts.push({cls:'warn',msg:`⚠️ IMPEDANCE: ${w.fl}Ω — verify amp stability.`});health-=8;}
    else rpts.push({cls:'ok',msg:`✅ IMPEDANCE: ${w.fl}Ω — stable.`});

    if(e.vd>0.5){rpts.push({cls:'bad',msg:`❌ VOLTAGE: ${e.vd}V drop. ${e.tv}V at amp. Upgrade wire or shorten run.`});health-=25;}
    else if(e.vd>0.3){rpts.push({cls:'warn',msg:`⚠️ VOLTAGE: ${e.vd}V drop — borderline. ${e.tv}V at amp.`});health-=10;}
    else rpts.push({cls:'ok',msg:`✅ VOLTAGE: ${e.vd}V drop — ${e.tv}V arriving clean.`});

    if(e.am<0){rpts.push({cls:'bad',msg:`❌ ALT: ${e.td}A draw vs ${inp.alt}A alt. Lights dim. Upgrade required.`});health-=20;}
    else if(e.am<20){rpts.push({cls:'warn',msg:`⚠️ ALT: ${e.am.toFixed(0)}A headroom only. Big 3 upgrade recommended.`});health-=10;}
    else rpts.push({cls:'ok',msg:`✅ ALT: ${e.am.toFixed(0)}A headroom — adequate.`});

    if(e.wlp>100){rpts.push({cls:'bad',msg:`❌ WIRE: ${gs('e_gauge')} rated ${e.mA}A drawing ${e.draw}A — fire hazard.`});health-=30;}
    else if(e.wlp>80){rpts.push({cls:'warn',msg:`⚠️ WIRE: ${gs('e_gauge')} at ${e.wlp}% — consider upgrading.`});health-=10;}
    else rpts.push({cls:'ok',msg:`✅ WIRE: ${gs('e_gauge')} at ${e.wlp}% capacity.`});

    const score=Math.max(0,Math.round(health));
    const buildID='BF-'+Math.random().toString(36).substr(2,9).toUpperCase();
    return{b,w,e,s,rpts,score,buildID,isCertified:score>=85};
  }
};

/* ═══════════════════════════════════════
   STATE + HELPERS
═══════════════════════════════════════ */
const ST={cm:'parallel',sm:'parallel',ac:'d',lastAudit:null,elecMode:'simple',bat2:false};
let SYS_AMPS=[
  {rms:1500,gauge:'1/0',len:15,cls:'d',ohms:1,label:'Sub Amp'},
  {rms:500, gauge:'4AWG',len:12,cls:'ab',ohms:4,label:'Full Range'},
];
function gv(id,d){const v=parseFloat(document.getElementById(id)?.value);return isNaN(v)?d:v;}
function gs(id){return document.getElementById(id)?.value||'';}
function H(id,h){const e=document.getElementById(id);if(e)e.innerHTML=h;}
function show(id,v){const e=document.getElementById(id);if(e)e.style.display=v?'block':'none';}
function sv(id,v){const e=document.getElementById(id);if(e)e.value=v;}

function sw(id){
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('panel-'+id).classList.add('active');
  document.getElementById('tab-'+id).classList.add('active');
  document.getElementById('panel-'+id).scrollTop=0;
  if(id==='wire')wireRun();
  if(id==='forge'){ var _vk=gs('t_veh')||'standard'; setTimeout(function(){showTrunkInfo(_vk);},50); }
  if(id==='elec')elecRun();
  if(id==='spl')splRun();
  if(id==='cuts')cutsRun();
  if(id==='subs'){ dbRenderBrands(); dbRenderModels(); }
  if(id==='comp')cmpRenderSlots();
  if(id==='studio'){ var s2=document.getElementById('studio-status'); if(s2&&s2.textContent==='')s2.textContent='IDLE'; }
  if(id==='quote') quoteRun();
  if(id==='led') ledRun();
  if(id==='hair') hairTrickRun();
  if(id==='blow'){ var _btv=document.getElementById('bt_netvol'); if(_btv) _btv.value=gv('af_vol',2.0); runBlowThru(); }
}

function lsync(){
  var _vk = gs("t_veh") || "standard";
  setTimeout(function(){ showTrunkInfo(_vk); }, 50);
  sv('e_rms',gv('t_rms',1000));sv('e_alt',gv('t_alt',130));
  sv('w_qty',gv('t_qty',2));sv('w_ohms',gs('t_ohms'));sv('w_dvc',gs('t_dvc'));
  sv('sp_s',gv('t_sens',87));sv('sp_w',gv('t_rms',1000));sv('sp_n',gv('t_qty',2));
}


/* ═══ RENDER PRESETS ═══ */
function renderPresets() {
  var container = document.getElementById('preset-grid');
  if (!container) return;
  container.innerHTML = PRESETS.map(function(p, i) {
    var tagColor = p.tag === 'SPL' ? 'var(--red)' : p.tag === 'COMP' ? 'var(--pu)' : p.tag === 'SQ' ? 'var(--ice)' : 'var(--gr)';
    return '<button class="pb" onclick="loadPreset(' + i + ')">' +
      '<div class="pn">' + p.name + '</div>' +
      '<div class="ps" style="font-family:Share Tech Mono,monospace;font-size:8px;color:' + tagColor + ';letter-spacing:1px;">' + p.tag + ' &bull; ' + p.qty + 'x' + p.sz + '&quot; &bull; ' + p.rms + 'W</div>' +
      '</button>';
  }).join('');
}

/* ═══ PRESETS ═══ */

function loadPreset(i){
  const p=PRESETS[i];
  sv('t_rms',p.rms);sv('t_qty',p.qty);sv('t_sz',p.sz);sv('t_ohms',p.ohms);
  sv('t_dvc',p.dvc);sv('t_sens',p.sens);
  sv('af_vol',p.vol);sv('af_tune',p.tune);sv('af_pw',p.pw);
  sv('b_disp',p.disp);
  ST.cm=p.coil;ST.sm=p.subs;
  document.querySelectorAll('#ctg button').forEach(b=>b.classList.remove('on'));
  document.getElementById(p.coil==='parallel'?'cm_par':'cm_ser').classList.add('on');
  document.querySelectorAll('#stg button').forEach(b=>b.classList.remove('on'));
  document.getElementById(p.subs==='parallel'?'sm_par':'sm_ser').classList.add('on');
  lsync();
}

/* ═══ AUTO-FORGE ═══ */
function runAF(){
  const tVol=gv('af_vol',2),tTune=gv('af_tune',34),pW=gv('af_pw',3);
  const wood=gv('af_wood',0.75),veh=gs('t_veh')||'standard';
  const sDsp=gv('b_disp',0.14),qty=gv('t_qty',2),sRms=gv('t_rms',1000);
  document.getElementById('af-spin').style.display='block';
  H('af-result','');
  setTimeout(()=>{
    const r=BF.autoForge(tVol,tTune,pW,wood,veh,sDsp,qty,sRms);
    document.getElementById('af-spin').style.display='none';
    if(!r){
      H('af-result',`<div class="ti bad" style="margin-top:8px;">❌ No valid width found for ${tVol} ft³ in this vehicle. Try smaller target volume, wider port, or different vehicle.</div>`);
      return;
    }
    sv('b_w',r.width);sv('b_h',r.height);sv('b_d',r.depth);
    sv('b_pw',pW);sv('b_pl',r.pLen);sv('b_wood',wood);
    sv('cs_w',r.width);sv('cs_h',r.height);sv('cs_d',r.depth);sv('cs_pw',pW);
    sv('sp_v',r.vel);
    const vc=r.vel<=17?'var(--gr)':r.vel<=25?'var(--gd)':'var(--red)';
    H('af-result',`
      <div class="afr">
        <div class="afr-title">${r.fitWarning ? '⚠️ CLOSEST MATCH' : '✅ AUTO-FORGE RESULT'}</div>
        ${r.fitWarning ? `<div class="ti warn" style="margin-bottom:8px;font-size:9px;">${r.fitWarning}</div>` : ''}
        <div style="font-family:'Share Tech Mono',monospace;font-size:8px;color:var(--mu);margin-bottom:8px;">VEHICLE: ${r.veh.toUpperCase()}</div>
        <div class="afdim">
          <div class="afb"><div class="afv">${r.width}"</div><div class="afl">WIDTH</div></div>
          <div class="afb"><div class="afv">${r.height}"</div><div class="afl">HEIGHT</div></div>
          <div class="afb"><div class="afv">${r.depth}"</div><div class="afl">DEPTH</div></div>
        </div>
        <div class="rl"><span class="rk">NET VOLUME</span><span class="rv gr">${r.net} ft³</span></div>
        <div class="rl"><span class="rk">TUNING FREQ</span><span class="rv gd">${r.fb} Hz</span></div>
        <div class="rl"><span class="rk">PORT AREA</span><span class="rv">${r.pA} in²</span></div>
        <div class="rl"><span class="rk">PORT LENGTH</span><span class="rv fire">${r.pLen}"</span></div>
        <div class="rl"><span class="rk">PORT VELOCITY</span><span class="rv" style="color:${vc}">${r.vel} m/s</span></div>
        <button class="btn sm" style="margin-top:10px;" onclick="sw('box');runBox()">→ OPEN IN BOX CALC</button>
      </div>`);
  },80);
}

/* ═══ MODULE 1 ═══ */
function runBox(){
  const dims={w:gv('b_w',32),h:gv('b_h',15),d:gv('b_d',18)};
  if(window._lastTrunkEntry){var _te=window._lastTrunkEntry;updateBoxTrunkWarn((_te.interior&&_te.interior.w)||0,(_te.interior&&_te.interior.h)||0,(_te.interior&&_te.interior.d)||0,(_te.opening&&_te.opening.w)||0,(_te.opening&&_te.opening.h)||0);}
  const isDblBaffle = gs('b_dbl')==='1';
  const port={w:gv('b_pw',3),len:gv('b_pl',24)};
  const sub={disp:gv('b_disp',0.14),rms:gv('t_rms',1000)};
  const qty=gv('t_qty',2),veh=gs('t_veh')||'standard';
  const wood=gv('b_wood',0.75),brace=gv('b_brace',0.03);
  const portType=gs('b_pt')||'slot';
  const r=BF.box(dims,sub,qty,port,veh,wood,brace,portType);
  if(!r){alert('Invalid dimensions — check width/height/depth vs wood thickness.');return;}
  const pt=PORT_LIB[portType]||PORT_LIB.slot;
  const vc=r.vel<pt.warnVel?'gr':r.vel<=pt.maxVel?'gd':'red';
  const fc=r.fb<28?'ice':r.fb>42?'gd':'gr';
  H('box-big',`
    <div class="bn"><div class="bv">${r.net}</div><div class="bl">NET FT³</div></div>
    <div class="bn"><div class="bv ${fc}">${r.fb}</div><div class="bl">TUNE Hz</div></div>
    <div class="bn"><div class="bv ${vc}">${r.vel}</div><div class="bl">VEL M/S</div></div>`);
  H('box-rows',`
    <div class="rl"><span class="rk">GROSS</span><span class="rv fire">${r.gross} ft³</span></div>
    <div class="rl"><span class="rk">SUB DISP</span><span class="rv">${r.sDsp} ft³</span></div>
    <div class="rl"><span class="rk">PORT DISP</span><span class="rv">${r.pDsp} ft³</span></div>
    <div class="rl"><span class="rk">NET VOLUME</span><span class="rv gr">${r.net} ft³</span></div>
    <div class="rl"><span class="rk">PORT AREA</span><span class="rv">${r.pA} in²</span></div>
    <div class="rl"><span class="rk">PORT TYPE</span><span class="rv ice">${pt.name}</span></div>
    <div class="rl"><span class="rk">INTERNAL W×H×D</span><span class="rv fire">${r.iW}" × ${r.iH}" × ${r.iD}"</span></div>
    <div class="rl"><span class="rk">TUNING</span><span class="rv ${fc}">${r.fb} Hz</span></div>
    <div class="rl"><span class="rk">PORT VELOCITY</span><span class="rv ${vc}">${r.vel} m/s ${r.vel<pt.warnVel?'✅ LAMINAR':r.vel<=pt.maxVel?'⚠️ ACCEPTABLE':'🔴 CHUFF RISK'}</span></div>
    <div class="rl" style="background:rgba(0,204,255,0.04);border:1px solid rgba(0,204,255,0.1);"><span class="rk">PORT NOTE</span><span class="rv" style="font-size:9px;color:var(--mu2)">${pt.desc}</span></div>`);
  show('box-res',true);
  // hair trick check lives in HAIR tab only
  const _staleHealth = document.getElementById('sub-health-card');
  if (_staleHealth) _staleHealth.remove();

  // TS HEALTH SECTION
  const _tsSpec = window._lastSubSpec || null;
  if (_tsSpec && _tsSpec.xmax) {
    const qty2 = gv('t_qty', 1);
    const rmsW = gv('t_rms', 1000);
    const excPct = TS.excursionPct(rmsW, _tsSpec.re||7, _tsSpec.xmax, _tsSpec.sd||330, _tsSpec.mms||285, _tsSpec.bl||32, r.net, r.fb, qty2);
    const thermalPct = TS.thermalPct(rmsW, _tsSpec.pe||_tsSpec.rms, qty2);
    const velPct = (r.vel / (PORT_LIB[portType]||PORT_LIB.slot).maxVel) * 100;
    const longScore = TS.longevity(excPct, thermalPct, velPct);
    const tips = TS.advice(excPct, thermalPct, velPct, _tsSpec.xmax);

    const excColor = excPct > 120 ? 'var(--red)' : excPct > 80 ? 'var(--gd)' : 'var(--gr)';
    const thermColor = thermalPct > 100 ? 'var(--red)' : thermalPct > 80 ? 'var(--gd)' : 'var(--gr)';
    const longColor = longScore >= 80 ? 'var(--gr)' : longScore >= 50 ? 'var(--gd)' : 'var(--red)';
    const longLabel = longScore >= 80 ? 'HEALTHY' : longScore >= 50 ? 'MODERATE STRESS' : 'HIGH RISK';

    const healthHTML = `
    <div class="card" id="sub-health-card" style="margin-top:10px;border-color:rgba(0,255,136,.2);">
      <div class="ct gr">// SUB HEALTH — v2.8</div>
      <div class="bn3" style="margin-bottom:10px;">
        <div class="bn">
          <div class="bv" style="color:${excColor}">${excPct !== null ? excPct + '%' : 'N/A'}</div>
          <div class="bl">XMAX USE</div>
        </div>
        <div class="bn">
          <div class="bv" style="color:${thermColor}">${thermalPct !== null ? thermalPct + '%' : 'N/A'}</div>
          <div class="bl">THERMAL</div>
        </div>
        <div class="bn">
          <div class="bv" style="color:${longColor}">${longScore !== null ? longScore : 'N/A'}</div>
          <div class="bl">LONGEVITY</div>
        </div>
      </div>

      <div style="margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;font-family:'Share Tech Mono',monospace;font-size:8px;color:var(--mu);margin-bottom:3px;">
          <span>CONE EXCURSION</span><span style="color:${excColor}">${excPct}% of Xmax (${_tsSpec.xmax}mm)</span>
        </div>
        <div style="height:8px;background:var(--stone4);border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:${Math.min(excPct||0,100)}%;background:${excColor};border-radius:4px;transition:width .5s;"></div>
        </div>
        ${excPct > 100 ? '<div style="height:8px;background:rgba(255,51,51,.15);border-radius:4px;overflow:hidden;margin-top:2px;"><div style="height:100%;width:' + Math.min((excPct-100)*2,100) + '%;background:var(--red);border-radius:4px;"></div></div><div style="font-family:Share Tech Mono,monospace;font-size:7px;color:var(--red);margin-top:2px;">EXCEEDING XMAX</div>' : ''}
      </div>

      <div style="margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;font-family:'Share Tech Mono',monospace;font-size:8px;color:var(--mu);margin-bottom:3px;">
          <span>THERMAL LOAD</span><span style="color:${thermColor}">${thermalPct}% of Pe (${_tsSpec.pe || _tsSpec.rms}W)</span>
        </div>
        <div style="height:8px;background:var(--stone4);border-radius:4px;overflow:hidden;">
          <div style="height:100%;width:${Math.min(thermalPct||0,100)}%;background:${thermColor};border-radius:4px;transition:width .5s;"></div>
        </div>
      </div>

      <div style="background:var(--stone3);border-radius:8px;padding:10px;margin-bottom:8px;">
        <div style="font-family:'Share Tech Mono',monospace;font-size:8px;color:${longColor};letter-spacing:2px;margin-bottom:6px;">LONGEVITY: ${longLabel}</div>
        ${tips.map(t => '<div style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--mu2);margin-bottom:3px;">&rsaquo; ' + t + '</div>').join('')}
      </div>

      <div class="rl"><span class="rk">Qts</span><span class="rv ice">${_tsSpec.qts}</span></div>
      <div class="rl"><span class="rk">Xmax</span><span class="rv fire">${_tsSpec.xmax} mm</span></div>
      <div class="rl"><span class="rk">Sd</span><span class="rv">${_tsSpec.sd} cm²</span></div>
      <div class="rl"><span class="rk">Vd</span><span class="rv">${_tsSpec.vd || (_tsSpec.sd * _tsSpec.xmax / 1000).toFixed(0)} cm³</span></div>
      <div class="rl"><span class="rk">Re</span><span class="rv">${_tsSpec.re || '—'} Ω</span></div>
      <div class="rl"><span class="rk">BL</span><span class="rv">${_tsSpec.bl || '—'} Tm</span></div>
    </div>`;

    const _existingHealth = document.getElementById('sub-health-card');
    if (_existingHealth) _existingHealth.remove();
    document.getElementById('box-res').insertAdjacentHTML('beforeend', healthHTML);
  }

  // Defer draw2D so browser paints box-res before canvas measures width
  var _d2w=dims.w,_d2h=dims.h,_d2d=dims.d,_d2pw=port.w,_d2ih=r.iH,_d2pl=port.len;
  var _d2sz=gv('t_sz',12),_d2qt=gv('t_qty',2),_d2pp=gs('b_port_pos')||'right',_d2db=gs('b_dbl')==='1';
  // 2D preview removed — use 3D viewer
  // Refresh 3D viewer
  refresh3DBox(dims.w,dims.h,dims.d,gv('t_sz',12),gv('t_qty',2),port.w,r.iH,gs('b_dbl')==='1');
  if(!_3D.scene && window.THREE){ init3DViewer(); }
  sv('cs_w',dims.w);sv('cs_h',dims.h);sv('cs_d',dims.d);
  // Sync to LED calc
  sv('led_w',dims.w); sv('led_h',dims.h); sv('led_d',dims.d);sv('cs_pw',port.w);sv('cs_db',gs('b_dbl'));sv('sp_v',r.vel);
  setTimeout(()=>document.getElementById('box-res').scrollIntoView({behavior:'smooth'}),100);
}

/* ═══ MODULE 2 ═══ */
function setC(m,el){ST.cm=m;document.querySelectorAll('#ctg button').forEach(b=>b.classList.remove('on'));el.classList.add('on');wireRun();}
function setS(m,el){ST.sm=m;document.querySelectorAll('#stg button').forEach(b=>b.classList.remove('on'));el.classList.add('on');wireRun();}
function wireRun(){
  const qty=gv('w_qty',1),ohms=gv('w_ohms',2),isDVC=gs('w_dvc')==='dvc';
  document.querySelectorAll('#ctg button').forEach(b=>{b.disabled=!isDVC;b.style.opacity=isDVC?'1':'0.3';});
  const r=BF.wire(qty,ohms,isDVC,ST.cm,ST.sm);
  let diag='';
  for(let i=0;i<Math.min(qty,6);i++){
    diag+=`<div class="wn"><div style="width:30px;height:30px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:14px;background:rgba(0,204,255,.1);border:1px solid rgba(0,204,255,.2);">🔊</div>
    <div><div class="wnl">SUB ${i+1}</div><div class="wns">${isDVC?'DVC '+ohms+'Ω/coil → '+r.ss+'Ω':'SVC '+ohms+'Ω'}</div></div></div>`;
    if(i<Math.min(qty,6)-1)diag+=`<div class="wline"></div>`;
  }
  if(qty>6)diag+=`<div class="ti info">+ ${qty-6} more subs in same config</div>`;
  H('wire-diag',diag);
  refreshWireDiagram();
  const oc=r.fl<1?'bad':r.fl<2?'warn':'safe';
  const rc=r.rating==='good'?'gr':r.rating==='unstable'?'red':'gd';
  H('wire-final',`
    <div class="rl"><span class="rk">CONFIG</span><span class="rv">${isDVC?'DVC':'SVC'} · ${ST.cm==='parallel'?'PAR':'SER'} coils · ${ST.sm==='parallel'?'PAR':'SER'} subs</span></div>
    <div class="rl"><span class="rk">SINGLE SUB Ω</span><span class="rv ice">${r.ss}Ω</span></div>
    <div class="rl"><span class="rk">FINAL AMP LOAD</span><span class="rv"><span class="ob ${oc}">${r.fl}Ω</span></span></div>
    <div class="rl"><span class="rk">STABILITY</span><span class="rv ${rc}">${r.rating.toUpperCase()}</span></div>`);
  H('wire-tbl',`
    <div class="rl"><span class="rk">1Ω STABILITY</span><span class="rv ${r.fl>=1?'gr':'red'}">${r.fl>=1?'AMP MUST BE 1Ω RATED':'❌ BELOW 1Ω — DANGER'}</span></div>
    <div class="rl"><span class="rk">2Ω STABILITY</span><span class="rv ${r.fl>=2?'gr':'gd'}">${r.fl>=2?'✅ SAFE':'⚠️ VERIFY AMP RATING'}</span></div>
    <div class="rl"><span class="rk">4Ω STABILITY</span><span class="rv ${r.fl>=4?'gr':'mu2'}">${r.fl>=4?'✅ MOST EFFICIENT':'N/A for this config'}</span></div>`);
}

/* ═══ MODULE 3 ═══ */
function setAC(cls,el){
  ST.ac=cls;
  document.querySelectorAll('#acg button').forEach(b=>b.classList.remove('on'));
  el.classList.add('on');
  H('ac-note','💡 '+AC_NOTES[cls]);
  elecRun();
}

function setElecMode(mode, el){
  ST.elecMode = mode;
  document.querySelectorAll('#elec-mode-tg button').forEach(b=>b.classList.remove('on'));
  el.classList.add('on');
  document.getElementById('elec-simple').style.display = mode==='simple' ? 'block' : 'none';
  document.getElementById('elec-system').style.display = mode==='system' ? 'block' : 'none';
  if(mode==='system') sysRun(); else elecRun();
}

function setBat2(on, el){
  ST.bat2 = on;
  document.querySelectorAll('#elec-system .tg button').forEach(b=>b.classList.remove('on'));
  el.classList.add('on');
  document.getElementById('bat2-inputs').style.display = on ? 'block' : 'none';
  sysRun();
}

function sysRenderAmps(){
  const gaugeOpts = ['4/0','2/0','1/0','2AWG','4AWG','8AWG'];
  const gaugeLabels = {'4/0':'4/0 AWG','2/0':'2/0 AWG','1/0':'1/0 AWG','2AWG':'2 AWG','4AWG':'4 AWG','8AWG':'8 AWG'};
  const rows = SYS_AMPS.map((a,i) => {
    const removeBtn = SYS_AMPS.length > 1
      ? '<button onclick="sysRemoveAmp('+i+')" style="background:rgba(255,51,51,.1);border:1px solid rgba(255,51,51,.3);border-radius:6px;color:var(--red);font-size:9px;padding:3px 10px;cursor:pointer;">REMOVE</button>'
      : '';
    const ohmsOpts = [0.5,1,2,4,8].map(o => '<option value="'+o+'"'+(a.ohms===o?' selected':'')+'>'+o+'&#8486;</option>').join('');
    const gaugeSelOpts = gaugeOpts.map(g => '<option value="'+g+'"'+(a.gauge===g?' selected':'')+'>'+gaugeLabels[g]+'</option>').join('');
    const clsOpts = [
      ['d','Class D - 85% (sub amp)'],
      ['ab','Class AB - 55% (full range)'],
      ['a','Class A - 30% (audiophile)']
    ].map(([v,l]) => '<option value="'+v+'"'+(a.cls===v?' selected':'')+'>'+l+'</option>').join('');
    return '<div class="card" style="border-color:rgba(255,208,0,.2);" id="sysamp_'+i+'">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
      '<div style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--gd);letter-spacing:2px;">AMP '+(i+1)+'</div>' +
      removeBtn + '</div>' +
      '<div class="ig" style="margin-bottom:6px;"><label>LABEL</label>' +
      '<input type="text" value="'+a.label+'" oninput="SYS_AMPS['+i+'].label=this.value" class="inp"></div>' +
      '<div class="g2">' +
      '<div class="ig"><label>RMS WATTS</label><input type="number" value="'+a.rms+'" class="inp" oninput="SYS_AMPS['+i+'].rms=+this.value;sysRunD()"></div>' +
      '<div class="ig"><label>IMPEDANCE (&#8486;)</label><select class="inp" oninput="SYS_AMPS['+i+'].ohms=+this.value;sysRunD()">'+ohmsOpts+'</select></div>' +
      '</div><div class="g2">' +
      '<div class="ig"><label>WIRE GAUGE</label><select class="inp" oninput="SYS_AMPS['+i+'].gauge=this.value;sysRunD()">'+gaugeSelOpts+'</select></div>' +
      '<div class="ig"><label>WIRE RUN (FT)</label><input type="number" value="'+a.len+'" class="inp" oninput="SYS_AMPS['+i+'].len=+this.value;sysRunD()"></div>' +
      '</div>' +
      '<div class="ig"><label>AMP CLASS</label><select class="inp" oninput="SYS_AMPS['+i+'].cls=this.value;sysRunD()">'+clsOpts+'</select></div>' +
      '</div>';
  }).join('');
  H('sys-amps-list', rows);
}

function sysAddAmp(){
  SYS_AMPS.push({rms:500,gauge:'4AWG',len:15,cls:'ab',ohms:4,label:'Amp '+(SYS_AMPS.length+1)});
  sysRenderAmps(); sysRun();
}

function sysRemoveAmp(i){
  SYS_AMPS.splice(i,1); sysRenderAmps(); sysRun();
}

function sysRun(){
  sysRenderAmps();
  const alt      = gv('sys_alt', 240);
  const baseLoad = gv('sys_load', 40);
  const mainG    = gs('sys_main_gauge') || '2/0';
  const mainLen  = gv('sys_main_len', 12);
  const V        = BF.cfg.V;
  const hasBat2  = ST.bat2;
  const bat2Ah   = gv('bat2_ah', 35);
  const bat2Type = gs('bat2_type') || 'agm';
  const batFactor= {agm:0.80, lifepo4:0.95, lead:0.50};
  const usableAh = bat2Ah * (batFactor[bat2Type] || 0.80);

  const ampResults = SYS_AMPS.map(a => {
    const eff  = AC_EFF[a.cls] || 0.85;
    const draw = a.rms / (V * eff);
    const R    = BF.cfg.R[a.gauge] || 0.0000981;
    const maxA = BF.cfg.maxA[a.gauge] || 300;
    const vd   = draw * R * a.len * 2;
    const tv   = V - vd;
    const fuse = Math.ceil((draw * 1.25) / 5) * 5;
    const wlp  = Math.round((draw / maxA) * 100);
    return { ...a, draw:+draw.toFixed(1), vd:+vd.toFixed(3), tv:+tv.toFixed(2), fuse, wlp, maxA, eff:Math.round(eff*100) };
  });

  const totalDraw = +ampResults.reduce((s,a) => s + a.draw, 0).toFixed(1);
  const totalRMS  = SYS_AMPS.reduce((s,a) => s + a.rms, 0);
  const mainR     = BF.cfg.R[mainG] || 0.0000618;
  const mainVd    = +(totalDraw * mainR * mainLen * 2).toFixed(3);
  const mainMaxA  = BF.cfg.maxA[mainG] || 400;
  const mainPct   = Math.round((totalDraw / mainMaxA) * 100);
  const altMargin = +(alt - totalDraw - baseLoad).toFixed(1);

  let reserveMin = null;
  if (hasBat2 && altMargin < 0) {
    reserveMin = +((usableAh / Math.abs(altMargin)) * 60).toFixed(0);
  } else if (hasBat2) {
    reserveMin = 999;
  }
  const sysFuse = Math.ceil((totalDraw * 1.25) / 10) * 10;

  const altC  = altMargin > 20 ? 'gr' : altMargin > 0 ? 'gd' : 'red';
  const mainC = mainPct > 80 ? 'red' : mainPct > 60 ? 'gd' : 'gr';

  H('sys-big',
    '<div class="bn"><div class="bv fire">'+totalDraw+'A</div><div class="bl">TOTAL DRAW</div></div>' +
    '<div class="bn"><div class="bv '+altC+'">'+(altMargin>0?'+':'')+altMargin+'A</div><div class="bl">ALT MARGIN</div></div>' +
    '<div class="bn"><div class="bv '+mainC+'">'+mainPct+'%</div><div class="bl">MAIN WIRE</div></div>' +
    '<div class="bn"><div class="bv gd">'+totalRMS+'W</div><div class="bl">TOTAL RMS</div></div>'
  );

  H('sys-rows',
    '<div class="rl"><span class="rk">ALTERNATOR</span><span class="rv fire">'+alt+'A</span></div>' +
    '<div class="rl"><span class="rk">BASE VEHICLE LOAD</span><span class="rv">'+baseLoad+'A</span></div>' +
    '<div class="rl"><span class="rk">ALL AMPS DRAW</span><span class="rv fire">'+totalDraw+'A</span></div>' +
    '<div class="rl"><span class="rk">TOTAL SYSTEM DRAW</span><span class="rv">'+(totalDraw+baseLoad).toFixed(1)+'A</span></div>' +
    '<div class="rl"><span class="rk">ALT HEADROOM</span><span class="rv '+altC+'">'+(altMargin>0?'+':'')+altMargin+'A</span></div>' +
    '<div class="rl"><span class="rk">MAIN WIRE ('+mainG+')</span><span class="rv '+mainC+'">'+mainPct+'% &middot; '+mainVd+'V drop</span></div>' +
    '<div class="rl"><span class="rk">DIST BLOCK FUSE</span><span class="rv ice">'+sysFuse+'A ANL</span></div>' +
    (hasBat2 ? '<div class="rl" style="background:rgba(0,255,136,.05);border-color:rgba(0,255,136,.15);"><span class="rk">2ND BATTERY RESERVE</span><span class="rv gr">'+(reserveMin===999?'BACKUP ONLY':''+reserveMin+' min')+'</span></div>' : '') +
    (hasBat2 ? '<div class="rl"><span class="rk">USABLE Ah</span><span class="rv gr">'+usableAh.toFixed(0)+' Ah ('+bat2Type.toUpperCase()+')</span></div>' : '')
  );

  H('sys-amp-rows', ampResults.map((a,i) => {
    const dc = a.vd > 0.5 ? 'red' : a.vd > 0.3 ? 'gd' : 'gr';
    const wc = a.wlp > 80 ? 'red' : a.wlp > 60 ? 'gd' : 'gr';
    return '<div style="background:var(--stone3);border-radius:9px;padding:10px;margin-bottom:8px;border:1px solid var(--stone4);">' +
      '<div style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--gd);letter-spacing:1px;margin-bottom:6px;">AMP '+(i+1)+' &mdash; '+a.label.toUpperCase()+'</div>' +
      '<div class="rl"><span class="rk">RMS / CLASS</span><span class="rv">'+a.rms+'W &middot; Class '+a.cls.toUpperCase()+' ('+a.eff+'%)</span></div>' +
      '<div class="rl" style="font-family:Russo One,sans-serif;"><span class="rk">IMPEDANCE</span><span class="rv ice">'+a.ohms+'&#8486;</span></div>' +
      '<div class="rl"><span class="rk">CURRENT DRAW</span><span class="rv fire">'+a.draw+'A</span></div>' +
      '<div class="rl"><span class="rk">WIRE &middot; '+a.gauge+'</span><span class="rv '+wc+'">'+a.wlp+'% of '+a.maxA+'A max</span></div>' +
      '<div class="rl"><span class="rk">VOLTAGE DROP</span><span class="rv '+dc+'">'+a.vd+'V &middot; '+a.tv+'V at amp</span></div>' +
      '<div class="rl"><span class="rk">FUSE</span><span class="rv">'+a.fuse+'A</span></div>' +
      '</div>';
  }).join(''));

  const needBig3 = totalDraw > 100;
  const needAlt  = altMargin < 20;
  H('sys-b3',
    '<div class="b3i"><div class="b3c '+(needBig3?'need':'done')+'">'+(needBig3?'!':'&#10003;')+'</div>' +
    '<div class="b3t"><div class="b3n">Main Power &mdash; Batt &rarr; ANL Fuse &rarr; Dist Block</div>' +
    '<div class="b3s">'+(needBig3 ? mainG+' OFC for '+totalDraw.toFixed(0)+'A' : 'Current gauge adequate')+'</div></div></div>' +
    '<div class="b3i"><div class="b3c '+(needBig3?'need':'done')+'">'+(needBig3?'!':'&#10003;')+'</div>' +
    '<div class="b3t"><div class="b3n">Big 3 Upgrade (Alt &rarr; Batt &rarr; Chassis)</div>' +
    '<div class="b3s">'+(needBig3 ? 'Match to '+mainG : 'Current size adequate')+'</div></div></div>' +
    '<div class="b3i"><div class="b3c '+(needAlt?'need':'done')+'">'+(needAlt?'!':'&#10003;')+'</div>' +
    '<div class="b3t"><div class="b3n">Alternator Output</div>' +
    '<div class="b3s">'+(needAlt ? 'Only '+altMargin.toFixed(0)+'A headroom' : alt+'A has '+altMargin.toFixed(0)+'A headroom')+'</div></div></div>' +
    (!hasBat2 && altMargin < 0 ? '<div class="b3i"><div class="b3c need">!</div><div class="b3t"><div class="b3n">Second Battery</div><div class="b3s">Alt deficit &mdash; second battery recommended</div></div></div>' : '')
  );

  const weakItems = [];
  ampResults.forEach(a => {
    const upgrades = {'4AWG':'2AWG','2AWG':'1/0','1/0':'2/0','2/0':'4/0'};
    if(a.wlp > 100) weakItems.push({level:'red',  msg: a.label+': '+a.gauge+' wire OVER capacity ('+a.wlp+'%) &mdash; upgrade to '+(upgrades[a.gauge]||'larger')});
    else if(a.wlp > 80) weakItems.push({level:'warn', msg: a.label+': '+a.gauge+' at '+a.wlp+'% &mdash; consider upgrading'});
    if(a.vd > 0.5) weakItems.push({level:'red', msg: a.label+': '+a.vd+'V drop &mdash; amp sees only '+a.tv+'V'});
  });
  if(mainPct > 100) weakItems.push({level:'red',  msg:'MAIN WIRE over capacity &mdash; immediate fire risk'});
  else if(mainPct > 80) weakItems.push({level:'warn', msg:'Main wire at '+mainPct+'% &mdash; upgrade recommended'});
  if(altMargin < 0) weakItems.push({level:'red', msg:'Alt deficit: '+Math.abs(altMargin).toFixed(0)+'A short &mdash; upgrade alternator'});

  H('sys-weak', weakItems.length === 0
    ? '<div class="ti ok">&#10003; No weak links &mdash; system looks solid</div>'
    : weakItems.map(w => '<div class="ti '+(w.level==='red'?'bad':'warn')+'">'+(w.level==='red'?'&#10060;':'&#9888;')+' '+w.msg+'</div>').join('')
  );

  show('sys-results', true);
}


// TRUNK DB LOOKUP FUNCTIONS
function tkLookup(make, model, year) {
  if (!TK_DB || !TK_DB.length) return null;
  var m = make.toLowerCase().trim();
  var mo = model.toLowerCase().trim();
  var y = String(year).trim();
  var match = TK_DB.filter(function(e) {
    return e.v.make.toLowerCase() === m && e.v.model.toLowerCase() === mo && String(e.v.year) === y;
  })[0];
  if (!match) match = TK_DB.filter(function(e) {
    return e.v.make.toLowerCase() === m && e.v.model.toLowerCase() === mo;
  })[0];
  return match || null;
}

function tkLookupByVehKey(vehKey) {
  if (!vehKey || vehKey === "standard") return null;
  var parts = vehKey.split("_");
  if (parts.length < 2) return null;
  var last = parts[parts.length - 1];
  var hasYear = (last.length === 4 && parseInt(last) > 1900 && parseInt(last) < 2030);
  var year = hasYear ? last : null;
  var rest = hasYear ? parts.slice(0, -1) : parts;
  var make  = rest[0];
  var model = rest.slice(1).join(" ");
  if (!make || !model) return null;
  return tkLookup(make, model, year);
}

function showTrunkInfo(vehKey) {
  var card = document.getElementById("trunk-info-card");
  if (!card) return;
  var entry = tkLookupByVehKey(vehKey);
  if (!entry) { card.style.display = "none"; return; }
  var iW = (entry.interior && entry.interior.w) || 0;
  var iH = (entry.interior && entry.interior.h) || 0;
  var iD = (entry.interior && entry.interior.d) || 0;
  var oW = (entry.opening  && entry.opening.w)  || 0;
  var oH = (entry.opening  && entry.opening.h)  || 0;
  var wW = (entry.wells    && entry.wells.floorW)|| 0;
  var wP = (entry.wells    && entry.wells.protrusion) || 0;
  var verified = entry.verified || "estimated";
  var notes = entry.notes || "";
  window._lastTrunkEntry = entry;
  var badge = document.getElementById("trunk-verified-badge");
  if (badge) {
    badge.textContent  = verified === "measured" ? "MEASURED" : "ESTIMATED";
    badge.style.background = verified === "measured" ? "rgba(0,255,136,.1)" : "rgba(255,208,0,.1)";
    badge.style.border = verified === "measured" ? "1px solid rgba(0,255,136,.3)" : "1px solid rgba(255,208,0,.3)";
    badge.style.color  = verified === "measured" ? "var(--gr)" : "var(--gd)";
  }
  H("trunk-dims-big",
    '<div class="bn"><div class="bv ice">' + iW + '"</div><div class="bl">INT WIDTH</div></div>' +
    '<div class="bn"><div class="bv ice">' + iH + '"</div><div class="bl">INT HEIGHT</div></div>' +
    '<div class="bn"><div class="bv ice">' + iD + '"</div><div class="bl">INT DEPTH</div></div>'
  );
  var rows =
    '<div class="rl"><span class="rk">TRUNK OPENING</span><span class="rv">' + oW + '" W x ' + oH + '" H</span></div>' +
    '<div class="rl"><span class="rk">FLOOR WIDTH (between wells)</span><span class="rv">' + wW + '"</span></div>';
  if (wP > 0) rows += '<div class="rl"><span class="rk">WHEEL WELL PROTRUSION</span><span class="rv gd">' + wP + '" each side</span></div>';
  if (notes) rows += '<div class="rl"><span class="rk">NOTES</span><span class="rv" style="font-size:9px;color:var(--mu2);text-align:right;max-width:60%;">' + notes + '</span></div>';
  rows += '<div class="rl"><span class="rk">SOURCE</span><span class="rv" style="font-size:9px;color:var(--mu)">' + (entry.by||"BassForge DB") + " - " + (entry.date||"") + '</span></div>';
  H("trunk-info-rows", rows);
  card.style.display = "block";
  updateBoxTrunkWarn(iW, iH, iD, oW, oH);
}

function applyTrunkToBox() {
  var e = window._lastTrunkEntry;
  if (!e) return;
  var iW = (e.interior && e.interior.w) || 0;
  var iH = (e.interior && e.interior.h) || 0;
  var iD = (e.interior && e.interior.d) || 0;
  if (iW) { sv("b_w", iW); sv("cs_w", iW); }
  if (iH) { sv("b_h", iH); sv("cs_h", iH); }
  if (iD) { sv("b_d", iD); sv("cs_d", iD); }
  sw("box");
  setTimeout(function(){ runBox(); }, 100);
  showForgeToast("DIMENSIONS APPLIED TO BOX");
}

function updateBoxTrunkWarn(maxW, maxH, maxD, openW, openH) {
  var el = document.getElementById("box-trunk-warn");
  if (!el) return;
  var bW = gv("b_w", 32), bH = gv("b_h", 15), bD = gv("b_d", 18);
  var warns = [];
  if (maxW > 0 && bW > maxW) warns.push("Box width " + bW + "\" exceeds trunk max " + maxW + "\"");
  if (maxH > 0 && bH > maxH) warns.push("Box height " + bH + "\" exceeds trunk max " + maxH + "\"");
  if (maxD > 0 && bD > maxD) warns.push("Box depth " + bD + "\" exceeds trunk max " + maxD + "\"");
  if (openW > 0 && bW > openW) warns.push("Box width " + bW + "\" won't fit through " + openW + "\" opening");
  if (openH > 0 && bH > openH) warns.push("Box height " + bH + "\" won't fit through " + openH + "\" opening");
  if (warns.length > 0) {
    el.innerHTML = warns.map(function(w){ return '<div class="ti bad" style="margin-bottom:4px;font-size:9px;">&#10060; ' + w + '</div>'; }).join("");
    el.style.display = "block";
  } else if (maxW > 0) {
    el.innerHTML = '<div class="ti ok" style="font-size:9px;">&#10003; Box fits &#8212; trunk is ' + maxW + '&#215;' + maxH + '&#215;' + maxD + '", opening ' + openW + '&#215;' + openH + '"</div>';
    el.style.display = "block";
  } else {
    el.style.display = "none";
  }
}

// SUB COMPARISON TOOL + BRACING ADVISOR
var CMP_MODE = "db";
var CMP_SLOTS = [
  {brand:"ct", modelIdx:8, custom:null},
  {brand:"sundown", modelIdx:6, custom:null}
];

function setCmpMode(mode, el) {
  CMP_MODE = mode;
  document.getElementById("cmp_db_btn").classList.toggle("on", mode === "db");
  document.getElementById("cmp_custom_btn").classList.toggle("on", mode === "custom");
  cmpRenderSlots();
}

function cmpAddSlot() {
  if (CMP_SLOTS.length >= 4) return;
  CMP_SLOTS.push({brand:"dc", modelIdx:0, custom:null});
  document.getElementById("cmp-add-btn").style.display = CMP_SLOTS.length >= 4 ? "none" : "block";
  cmpRenderSlots();
}

function cmpRemoveSlot(i) {
  CMP_SLOTS.splice(i, 1);
  document.getElementById("cmp-add-btn").style.display = "block";
  cmpRenderSlots();
}

function cmpCustomInputs(i, slot) {
  var c = slot.custom || {};
  function numInp(label, field, val, step) {
    var sa = step ? ' step="' + step + '"' : '';
    return '<div class="ig"><label>' + label + '</label>' +
      '<input type="number" class="inp" value="' + val + '"' + sa +
      ' oninput="cmpSetC(' + i + ',\'' + field + '\',+this.value)"></div>';
  }
  var nameF = '<div class="ig"><label>NAME</label>' +
    '<input type="text" class="inp" value="' + (c.label || 'Sub ' + (i+1)) + '"' +
    ' oninput="cmpSetC(' + i + ',\'label\',this.value)"></div>';
  return '<div class="g3">' + nameF + numInp('SIZE in','sz',c.sz||10) + numInp('RMS W','rms',c.rms||1000) + '</div>' +
    '<div class="g3">' + numInp('SENS dB','sens',c.sens||85,0.1) + numInp('Fs Hz','fs',c.fs||35,0.1) + numInp('Qts','qts',c.qts||0.4,0.01) + '</div>' +
    '<div class="g2">' + numInp('Xmax mm','xmax',c.xmax||15) + numInp('Vas L','vas',c.vas||30,0.5) + '</div>';
}

function cmpRenderSlots() {
  var brands = Object.keys(SUB_DB);
  var colors = ['var(--fire)','var(--gr)','var(--gd)','var(--ice)'];
  var slotHTML = CMP_SLOTS.map(function(slot, i) {
    var brandOpts = brands.map(function(bk) {
      return '<option value="' + bk + '"' + (slot.brand === bk ? ' selected' : '') + '>' + (BRAND_NAMES[bk]||bk) + '</option>';
    }).join('');
    var models = SUB_DB[slot.brand] || [];
    var modelOpts = models.map(function(s, mi) {
      return '<option value="' + mi + '"' + (slot.modelIdx === mi ? ' selected' : '') + '>' + s.model + ' ' + s.sz + '" ' + s.rms + 'W</option>';
    }).join('');
    var removeBtn = CMP_SLOTS.length > 1
      ? '<button onclick="cmpRemoveSlot(' + i + ')" style="background:rgba(255,51,51,.1);border:1px solid rgba(255,51,51,.3);border-radius:6px;color:var(--red);font-size:9px;padding:3px 10px;cursor:pointer;">REMOVE</button>'
      : '';
    var dbPart = CMP_MODE === 'db'
      ? '<div class="g2"><div class="ig"><label>BRAND</label><select class="inp" onchange="cmpSetBrand(' + i + ',this.value)">' + brandOpts + '</select></div>' +
        '<div class="ig"><label>MODEL</label><select class="inp" onchange="cmpSetModel(' + i + ',+this.value)">' + modelOpts + '</select></div></div>'
      : cmpCustomInputs(i, slot);
    var borderColor = colors[i].replace('var(','rgba(').replace(')',',0.4)').replace('--fire','255,77,0').replace('--gr','0,255,136').replace('--gd','255,208,0').replace('--ice','0,204,255');
    return '<div class="card" style="border-color:' + borderColor + ';">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
      '<div style="font-family:Share Tech Mono,monospace;font-size:9px;color:' + colors[i] + ';letter-spacing:2px;">SUB ' + (i+1) + '</div>' +
      removeBtn + '</div>' + dbPart + '</div>';
  }).join('');
  H('cmp-slots', slotHTML);
  cmpRun();
}

function cmpSetBrand(i, bk) {
  CMP_SLOTS[i].brand = bk;
  CMP_SLOTS[i].modelIdx = 0;
  cmpRenderSlots();
}

function cmpSetModel(i, idx) {
  CMP_SLOTS[i].modelIdx = idx;
  cmpRun();
}

function cmpSetC(i, field, val) {
  if (!CMP_SLOTS[i].custom) CMP_SLOTS[i].custom = {};
  CMP_SLOTS[i].custom[field] = val;
  cmpRun();
}

function cmpGetSpec(slot) {
  if (CMP_MODE === 'custom') return slot.custom || {};
  var models = SUB_DB[slot.brand] || [];
  return models[slot.modelIdx] || models[0] || {};
}

function cmpRun() {
  var rmsW = gv('cmp_rms', 1500);
  var vol  = gv('cmp_vol', 1.0);
  var tune = gv('cmp_tune', 36);
  var specs = CMP_SLOTS.map(function(slot) { return cmpGetSpec(slot); });
  if (specs.length < 2) { show('cmp-results', false); return; }

  var colors = ['var(--fire)','var(--gr)','var(--gd)','var(--ice)'];

  var results = specs.map(function(s, i) {
    var lbl  = CMP_MODE === 'custom' ? (s.label || ('Sub '+(i+1))) : (s.model || ('Sub '+(i+1)));
    var rmsS = s.rms  || 1000;
    var sens = s.sens || 85;
    var fs   = s.fs   || 35;
    var qts  = s.qts  || 0.4;
    var vas  = s.vas  || 30;
    var xmax = s.xmax || 0;
    var sd   = s.sd   || 300;
    var mms  = s.mms  || 200;
    var bl2  = s.bl   || 20;
    var re2  = s.re   || 4;
    var spl  = +(sens + 10*Math.log10(rmsW) + 7).toFixed(1);
    var excPct = (xmax && sd && mms && bl2 && re2) ? TS.excursionPct(rmsW, re2, xmax, sd, mms, bl2, vol, tune, 1) : null;
    var sealedVol = (qts && vas) ? TS.sealedVol(qts, vas, 0.707) : null;
    var portedVol = (qts && vas) ? TS.portedVol(qts, vas) : null;
    var portedFb  = (fs && qts)  ? TS.portedFb(fs, qts)   : null;
    var f3        = (sealedVol && fs && qts && vas) ? TS.sealedF3(fs, qts, vas, sealedVol) : null;
    var thermalPct = Math.round((rmsW / rmsS) * 100);
    return {lbl:lbl, sz:s.sz||10, rms:rmsS, sens:sens, fs:fs, qts:qts, vas:vas, xmax:xmax,
            spl:spl, excPct:excPct, sealedVol:sealedVol, portedVol:portedVol,
            portedFb:portedFb, f3:f3, thermalPct:thermalPct};
  });

  var bestSPL   = Math.max.apply(null, results.map(function(r){ return r.spl; }));
  var excList   = results.filter(function(r){ return r.excPct !== null; });
  var lowestExc = excList.length ? Math.min.apply(null, excList.map(function(r){ return r.excPct; })) : null;
  var lowestThm = Math.min.apply(null, results.map(function(r){ return r.thermalPct; }));
  var highXmax  = Math.max.apply(null, results.map(function(r){ return r.xmax||0; }));

  var metrics = [
    {lb:'Size',                fn:function(r){ return r.sz + '"'; }},
    {lb:'RMS Rating',          fn:function(r){ return r.rms + 'W'; }},
    {lb:'Sensitivity',         fn:function(r){ return r.sens + ' dB'; }},
    {lb:'Fs',                  fn:function(r){ return r.fs + ' Hz'; }},
    {lb:'Qts',                 fn:function(r){ return r.qts; }},
    {lb:'Xmax',                fn:function(r){ return r.xmax ? r.xmax+' mm':'--'; }, star:function(r){ return r.xmax===highXmax&&highXmax>0; }},
    {lb:'Sealed Optimal',      fn:function(r){ return r.sealedVol ? r.sealedVol+' ft\u00b3':'--'; }},
    {lb:'Ported Optimal',      fn:function(r){ return r.portedVol  ? r.portedVol+' ft\u00b3':'--'; }},
    {lb:'Optimal Fb',          fn:function(r){ return r.portedFb   ? r.portedFb+' Hz':'--'; }},
    {lb:'F3 Sealed',           fn:function(r){ return r.f3         ? r.f3+' Hz':'--'; }},
    {lb:'Pred SPL @ '+rmsW+'W',fn:function(r){ return r.spl+' dB'; }, star:function(r){ return r.spl===bestSPL; }, hi:true},
    {lb:'Excursion @ '+rmsW+'W',fn:function(r){ return r.excPct!==null?r.excPct+'%':'N/A'; }, star:function(r){ return r.excPct===lowestExc&&r.excPct!==null; }, hi:true},
    {lb:'Thermal Load',        fn:function(r){ return r.thermalPct+'%'; }, star:function(r){ return r.thermalPct===lowestThm; }, hi:true}
  ];

  var hdr = '<tr><td style="padding:5px 4px;font-size:7px;color:var(--mu);font-family:Share Tech Mono,monospace;"></td>' +
    results.map(function(r,i){
      return '<td style="padding:5px 8px;font-size:10px;color:'+colors[i]+';font-weight:700;text-align:center;min-width:72px;font-family:Share Tech Mono,monospace;">'+r.lbl+'</td>';
    }).join('') + '</tr>';

  var trows = metrics.map(function(m) {
    var cells = results.map(function(r,i){
      var win  = m.star && m.star(r);
      var clr  = win ? 'var(--gr)' : colors[i];
      var fw   = win ? 'font-weight:700;' : '';
      var fz   = m.hi ? '11' : '10';
      return '<td style="padding:5px 8px;font-size:'+fz+'px;color:'+clr+';'+fw+'text-align:center;font-family:Share Tech Mono,monospace;">' + m.fn(r) + (win?' \u2605':'') + '</td>';
    }).join('');
    var rbg = m.hi ? 'background:rgba(255,255,255,.02);' : '';
    return '<tr style="'+rbg+'border-bottom:1px solid rgba(255,255,255,.04);">' +
      '<td style="padding:5px 4px;font-size:7px;color:var(--mu);white-space:nowrap;font-family:Share Tech Mono,monospace;">'+m.lb+'</td>' + cells + '</tr>';
  }).join('');

  H('cmp-table', '<table style="width:100%;border-collapse:collapse;">'+hdr+trows+'</table>');

  var splWin  = results.reduce(function(a,b){ return a.spl>b.spl?a:b; });
  var excWin  = excList.length ? excList.reduce(function(a,b){ return (a.excPct||999)<(b.excPct||999)?a:b; }) : null;
  var thmWin  = results.reduce(function(a,b){ return a.thermalPct<b.thermalPct?a:b; });
  var xmaxWin = results.filter(function(r){return r.xmax;}).length ?
    results.filter(function(r){return r.xmax;}).reduce(function(a,b){return(a.xmax||0)>(b.xmax||0)?a:b;}) : null;
  var dailyWin = results.reduce(function(a,b){
    var as = a.spl*0.35+(100-(a.excPct||80))*0.4+(100-a.thermalPct)*0.25;
    var bs = b.spl*0.35+(100-(b.excPct||80))*0.4+(100-b.thermalPct)*0.25;
    return as>bs?a:b;
  });

  var vhtml =
    cmpV('\ud83c\udf89 LOUDEST', splWin.lbl, 'Highest predicted SPL at '+splWin.spl+' dB', 'fire') +
    (excWin ? cmpV('\ud83d\udcaa MOST CONE HEADROOM', excWin.lbl, 'Lowest excursion at this power ('+excWin.excPct+'% of Xmax)', 'gr') : '') +
    cmpV('\ud83d\udd25 LEAST THERMAL STRESS', thmWin.lbl, 'Running at '+thmWin.thermalPct+'% of rated power', 'gd') +
    (xmaxWin ? cmpV('\ud83d\udccd MOST XMAX', xmaxWin.lbl, xmaxWin.xmax+' mm single-way', 'ice') : '') +
    cmpV('\ud83c\udfc6 BEST ALL-ROUND', dailyWin.lbl, 'Best balance of SPL, headroom and thermal margin', 'pu');
  H('cmp-verdict', vhtml);
  show('cmp-results', true);
}

function cmpV(label, subName, reason, color) {
  return '<div style="background:var(--stone3);border-radius:9px;padding:10px 12px;margin-bottom:6px;border-left:3px solid var(--'+color+');">' +
    '<div style="font-family:Share Tech Mono,monospace;font-size:7px;color:var(--mu);letter-spacing:2px;margin-bottom:3px;">'+label+'</div>' +
    '<div style="font-family:Russo One,sans-serif;font-size:14px;color:var(--'+color+');margin-bottom:2px;">'+subName+'</div>' +
    '<div style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--mu2);">'+reason+'</div></div>';
}


// BRACING ADVISOR
function braceAdvisor(w, h, d, woodT, rmsW) {
  var t  = woodT || 0.75;
  var iW = +(w - t*2).toFixed(2);
  var iH = +(h - t*2).toFixed(2);
  var iD = +(d - t*2).toFixed(2);
  var pf = rmsW > 2000 ? 0.85 : rmsW > 1000 ? 0.90 : 1.0;
  var matLabel = t >= 1.0 ? '1" MDF strip' : t >= 0.75 ? '3/4" MDF strip' : '1/2" MDF strip';
  var braces = [];

  if (w > 18 * pf) {
    var n = w > 30 * pf ? 2 : 1;
    for (var i = 1; i <= n; i++) {
      var pos = +((iW / (n+1)) * i).toFixed(1);
      braces.push({
        panel: 'Top + Bottom Panels',
        cut:   iD + '" long x ' + (t*0.75).toFixed(2) + '" wide x ' + iH + '" tall',
        material: matLabel,
        pos:  'Center at ' + pos + '" from left wall, running full depth',
        note: 'Glue + screw from outside top and bottom panels. Pre-drill to prevent splitting.',
        priority: n === 2 ? 'HIGH' : 'MEDIUM'
      });
    }
  }

  if (iD > 18 * pf) {
    braces.push({
      panel: 'Side Panels',
      cut:   iH + '" tall x ' + t + '" wide x ' + (t*0.75).toFixed(2) + '" thick',
      material: matLabel,
      pos:  'Center at ' + (iD/2).toFixed(1) + '" from front baffle, top to bottom',
      note: 'Dado slot or glue + pocket screws from outside side panel.',
      priority: iD > 24 ? 'HIGH' : 'MEDIUM'
    });
  }

  if (w > 28 && h > 13 && rmsW > 1000) {
    braces.push({
      panel: 'Top to Bottom — Compression Brace',
      cut:   iH + '" (measure between inside panels)',
      material: '3/4" hardwood dowel  OR  1/2" threaded rod + washers + nuts',
      pos:  (iW*0.33).toFixed(1) + '" and ' + (iW*0.67).toFixed(1) + '" from left wall, centered depth',
      note: 'Drill 3/4" hole through top and bottom panels. Glue dowel or tighten rod snug. Eliminates flex at high SPL.',
      priority: 'HIGH'
    });
  }

  var matNote;
  if (t < 0.75) {
    matNote = {cls:'warn', txt:'Your box uses 1/2" wood — upgrade to 3/4" MDF for ' + rmsW + 'W builds. Bracing is essential at this thickness.'};
  } else if (rmsW > 2000) {
    matNote = {cls:'bad',  txt:'High power build — consider 1" MDF or double-layer 3/4"+1/2" on the baffle for maximum rigidity.'};
  } else {
    matNote = {cls:'ok',   txt:'3/4" MDF with these braces handles ' + rmsW + 'W cleanly at this box size.'};
  }
  return {braces:braces, matNote:matNote};
}

function runBraceAdvisor() {
  var w    = gv('cs_w',32), h = gv('cs_h',15), d = gv('cs_d',18);
  var mk   = gs('cs_mat') || 'mdf75';
  var t    = (MATS[mk] && MATS[mk].t) || 0.75;
  var rmsW = gv('t_rms',1000) * (gv('t_qty',2)||1);
  var card = document.getElementById('brace-advisor-card');
  if (!card) return;
  var res  = braceAdvisor(w, h, d, t, rmsW);

  if (res.braces.length === 0) {
    H('brace-output', '<div class="ti ok">&#10003; Box is compact enough at this power level — standard glue + screw construction is sufficient.</div>');
    card.style.display = 'block';
    return;
  }

  var pClr = {HIGH:'var(--red)', MEDIUM:'var(--gd)', LOW:'var(--gr)'};
  var rows = res.braces.map(function(b, i) {
    var pc = pClr[b.priority] || 'var(--mu)';
    return '<div style="background:var(--stone3);border-radius:9px;padding:12px;margin-bottom:8px;border-left:3px solid '+pc+';">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
      '<div style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--gd);letter-spacing:1px;">BRACE '+(i+1)+' \u2014 '+b.panel.toUpperCase()+'</div>' +
      '<span style="font-family:Share Tech Mono,monospace;font-size:7px;padding:2px 8px;border-radius:20px;background:rgba(255,255,255,.05);color:'+pc+';">'+b.priority+'</span>' +
      '</div>' +
      '<div class="rl"><span class="rk">CUT SIZE</span><span class="rv fire">'+b.cut+'</span></div>' +
      '<div class="rl"><span class="rk">MATERIAL</span><span class="rv">'+b.material+'</span></div>' +
      '<div class="rl"><span class="rk">POSITION</span><span class="rv gd">'+b.pos+'</span></div>' +
      '<div style="font-family:Share Tech Mono,monospace;font-size:8px;color:var(--mu2);margin-top:6px;line-height:1.6;">'+b.note+'</div>' +
      '</div>';
  }).join('');

  rows += '<div class="ti '+res.matNote.cls+'" style="margin-top:6px;">'+res.matNote.txt+'</div>';
  H('brace-output', rows);
  card.style.display = 'block';
}


// BANDPASS CALCULATORS — 4th order and 6th order
// Added to BassForge v3.5

// Current box mode — 'ported' | 'sealed' | 'bp4' | 'bp6'
var BOX_MODE = 'ported';

function setBoxMode(mode) {
  BOX_MODE = mode;
  ['ported','sealed','bp4','bp6'].forEach(function(m) {
    var btn = document.getElementById('bm_' + m);
    if (btn) btn.classList.toggle('on', m === mode);
  });
  // Show/hide relevant input sections
  var sections = {
    'bm-ported-inputs': mode === 'ported',
    'bm-sealed-inputs': mode === 'sealed',
    'bm-bp4-inputs':    mode === 'bp4',
    'bm-bp6-inputs':    mode === 'bp6',
    'bm-shared-inputs': true  // always show
  };
  Object.keys(sections).forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = sections[id] ? 'block' : 'none';
  });
  // Clear results
  show('box-res', false);
}

// ──────────────────────────────────────────────
// 4TH ORDER BANDPASS MATH
// Sealed rear + ported front
// ──────────────────────────────────────────────
var BP4 = {
  // Rear sealed chamber — typically 0.6-0.8x optimal sealed vol
  rearVol: function(qts, vas) {
    var vb = TS.sealedVol(qts, vas, 0.707);
    return +(vb * 0.70).toFixed(3);
  },
  // Front ported chamber — typically 0.8-1.2x optimal ported vol
  frontVol: function(qts, vas) {
    var vb = TS.portedVol(qts, vas);
    return +(vb * 1.0).toFixed(3);
  },
  // Front tuning — typically 0.9-1.1x Fb
  frontTune: function(fs, qts) {
    return TS.portedFb(fs, qts);
  },
  // Passband — flat ±3dB bandwidth
  lowF3: function(fs, qts) {
    return +(fs * Math.pow(qts, 0.8) * 0.6).toFixed(1);
  },
  highF3: function(fs, qts, fbFront) {
    return +(Math.sqrt(fs * fbFront) * 1.25).toFixed(1);
  },
  // Peak SPL boost over infinite baffle (dB)
  peakBoost: function(qts) {
    return +(6 + (0.4 - qts) * 10).toFixed(1);
  },
  // Sensitivity in passband (dB at 1W/1m)
  bandSens: function(sens, qts) {
    var boost = BP4.peakBoost(qts);
    return +(sens + Math.max(0, Math.min(boost, 10))).toFixed(1);
  }
};

function runBP4() {
  var w     = gv('b_w', 32), h = gv('b_h', 15), d = gv('b_d', 18);
  var wood  = gv('b_wood', 0.75);
  var sub   = window._lastSubSpec || {};
  var qty   = gv('t_qty', 1);
  var rmsW  = gv('t_rms', 1000);
  var fs    = sub.fs  || gv('bp4_fs',  35);
  var qts   = sub.qts || gv('bp4_qts', 0.4);
  var vas   = sub.vas || gv('bp4_vas', 30);
  var sens  = sub.sens || gv('t_sens', 85);
  var sz    = sub.sz  || gv('t_sz', 12);

  // Override with manual inputs if user typed them
  if (gv('bp4_fs',0))  fs  = gv('bp4_fs', fs);
  if (gv('bp4_qts',0)) qts = gv('bp4_qts', qts);
  if (gv('bp4_vas',0)) vas = gv('bp4_vas', vas);

  var rearVol  = gv('bp4_rear', 0)  || BP4.rearVol(qts, vas);
  var frontVol = gv('bp4_front', 0) || BP4.frontVol(qts, vas);
  var frontFb  = gv('bp4_tune', 0)  || BP4.frontTune(fs, qts);
  rearVol  = +rearVol.toFixed(3);
  frontVol = +frontVol.toFixed(3);
  frontFb  = +frontFb.toFixed(1);

  var totalVol = +(rearVol + frontVol).toFixed(3);
  var lowF3    = BP4.lowF3(fs, qts);
  var highF3   = BP4.highF3(fs, qts, frontFb);
  var bandwidth = +(highF3 - lowF3).toFixed(1);
  var peakBoost = BP4.peakBoost(qts);
  var bandSens  = BP4.bandSens(sens, qts);
  var predSPL   = +(bandSens + 10*Math.log10(rmsW) + 7).toFixed(1);

  // Warn if Qts is too high for bandpass
  var warning = qts > 0.5 ? 'High Qts (' + qts + ') — bandpass less efficient. Works best with Qts 0.25-0.45.' : null;
  var qtsNote = qts < 0.25 ? 'Very low Qts — bandpass will be very peaky. Consider ported instead.' : null;

  // Box geometry — recommend split roughly proportional to volumes
  var rearRatio = rearVol / totalVol;
  var rearDepth = +(d * rearRatio * 0.9).toFixed(1);
  var frontDepth = +(d - rearDepth - wood).toFixed(1);

  var big = '<div class="bn"><div class="bv fire">' + totalVol + '</div><div class="bl">TOTAL FT\u00b3</div></div>' +
    '<div class="bn"><div class="bv gr">' + lowF3 + ' - ' + highF3 + '</div><div class="bl">PASSBAND Hz</div></div>' +
    '<div class="bn"><div class="bv gd">' + predSPL + '</div><div class="bl">PRED SPL dB</div></div>';

  var rows =
    '<div class="rl"><span class="rk">REAR CHAMBER (sealed)</span><span class="rv fire">' + rearVol + ' ft\u00b3</span></div>' +
    '<div class="rl"><span class="rk">FRONT CHAMBER (ported)</span><span class="rv fire">' + frontVol + ' ft\u00b3</span></div>' +
    '<div class="rl"><span class="rk">FRONT PORT TUNING</span><span class="rv gd">' + frontFb + ' Hz</span></div>' +
    '<div class="rl"><span class="rk">TOTAL VOLUME</span><span class="rv">' + totalVol + ' ft\u00b3</span></div>' +
    '<div class="rl"><span class="rk">LOW F3</span><span class="rv ice">' + lowF3 + ' Hz</span></div>' +
    '<div class="rl"><span class="rk">HIGH F3</span><span class="rv ice">' + highF3 + ' Hz</span></div>' +
    '<div class="rl"><span class="rk">BANDWIDTH</span><span class="rv">' + bandwidth + ' Hz</span></div>' +
    '<div class="rl"><span class="rk">PEAK BOOST</span><span class="rv gd">+' + Math.max(0,peakBoost).toFixed(1) + ' dB over IB</span></div>' +
    '<div class="rl"><span class="rk">BAND SENSITIVITY</span><span class="rv">' + bandSens + ' dB</span></div>' +
    '<div class="rl"><span class="rk">PRED SPL @ ' + rmsW + 'W</span><span class="rv gd">' + predSPL + ' dB</span></div>' +
    '<div class="rl"><span class="rk">REAR DEPTH (est.)</span><span class="rv">' + rearDepth + '"</span></div>' +
    '<div class="rl"><span class="rk">FRONT DEPTH (est.)</span><span class="rv">' + frontDepth + '"</span></div>';

  var tipHTML = '';
  if (warning) tipHTML += '<div class="ti warn">\u26a0\ufe0f ' + warning + '</div>';
  if (qtsNote) tipHTML += '<div class="ti warn">\u26a0\ufe0f ' + qtsNote + '</div>';
  tipHTML += '<div class="ti info" style="margin-top:6px;">\ud83d\udca1 4th order bandpass concentrates output in a narrow band. SPL competitors use this for maximum output at a target frequency. Daily builds should use ported instead for broader response.</div>';

  H('box-big', big);
  H('box-rows', rows + tipHTML);

  // Auto-fill the manual inputs with calculated values
  sv('bp4_rear', rearVol);
  sv('bp4_front', frontVol);
  sv('bp4_tune', frontFb);

  show('box-res', true);

  // 2D preview — dual chamber
  drawBP4('box-cv', w, h, d, rearDepth, frontDepth, wood, sz, qty);
}

function drawBP4(id, bW, bH, bD, rearD, frontD, woodT, sz, qty) {
  var canvas = document.getElementById(id);
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var cW = canvas.width = canvas.offsetWidth || 320;
  var cH = canvas.height = 200;
  ctx.clearRect(0, 0, cW, cH);

  var scale = Math.min((cW - 40) / bW, (cH - 40) / bH);
  var ox = (cW - bW*scale) / 2;
  var oy = (cH - bH*scale) / 2;
  var bWp = bW*scale, bHp = bH*scale;
  var rDp = rearD*scale, fDp = frontD*scale;
  var wTp = woodT*scale;

  // Outer box
  ctx.fillStyle = '#1a1a1a';
  ctx.strokeStyle = 'rgba(255,208,0,0.6)';
  ctx.lineWidth = 2;
  ctx.fillRect(ox, oy, bWp, bHp);
  ctx.strokeRect(ox, oy, bWp, bHp);

  // Center divider (baffle between chambers)
  var divX = ox + rDp;
  ctx.strokeStyle = 'rgba(255,77,0,0.8)';
  ctx.lineWidth = wTp;
  ctx.beginPath(); ctx.moveTo(divX, oy); ctx.lineTo(divX, oy+bHp); ctx.stroke();

  // Sub hole in divider (centered)
  var subR = (sz * 0.45 * scale) / 2;
  var subY = oy + bHp/2;
  ctx.fillStyle = '#111';
  ctx.strokeStyle = 'rgba(0,255,136,0.8)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(divX, subY, subR, 0, Math.PI*2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(0,255,136,0.5)';
  ctx.font = 'bold ' + Math.max(7, scale*1.2) + 'px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(sz + '"', divX, subY + 3);

  // Port in front chamber (right side)
  var portW = 3*scale, portH = bHp*0.35;
  var portX = ox + bWp - portW;
  var portY = oy + (bHp - portH)/2;
  ctx.fillStyle = 'rgba(0,204,255,0.15)';
  ctx.strokeStyle = 'rgba(0,204,255,0.7)';
  ctx.lineWidth = 1;
  ctx.fillRect(portX, portY, portW, portH);
  ctx.strokeRect(portX, portY, portW, portH);

  // Labels
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '7px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('SEALED', ox + rDp/2, oy + bHp/2 - subR - 8);
  ctx.fillText('REAR', ox + rDp/2, oy + bHp/2 - subR - 1);
  ctx.fillStyle = 'rgba(0,204,255,0.6)';
  ctx.fillText('PORTED', ox + rDp + fDp/2, oy + bHp/2 - subR - 8);
  ctx.fillText('FRONT', ox + rDp + fDp/2, oy + bHp/2 - subR - 1);
}

// ──────────────────────────────────────────────
// 6TH ORDER BANDPASS MATH
// Ported rear + ported front
// ──────────────────────────────────────────────
var BP6 = {
  rearVol: function(qts, vas) {
    return +(TS.portedVol(qts, vas) * 0.8).toFixed(3);
  },
  frontVol: function(qts, vas) {
    return +(TS.portedVol(qts, vas) * 1.2).toFixed(3);
  },
  rearTune: function(fs, qts) {
    // Rear tuned slightly above Fs for SPL peak
    return +(fs * 1.1).toFixed(1);
  },
  frontTune: function(fs, qts) {
    // Front tuned lower for extension
    return +(TS.portedFb(fs, qts) * 0.85).toFixed(1);
  },
  lowF3: function(fs, qts, fbFront) {
    return +(Math.min(fs, fbFront) * 0.7).toFixed(1);
  },
  highF3: function(fs, qts, fbRear) {
    return +(Math.max(fs, fbRear) * 1.4).toFixed(1);
  },
  peakBoost: function(qts) {
    // 6th order can achieve higher peak than 4th
    return +(10 + (0.4 - qts) * 12).toFixed(1);
  },
  bandSens: function(sens, qts) {
    var boost = BP6.peakBoost(qts);
    return +(sens + Math.max(0, Math.min(boost, 14))).toFixed(1);
  }
};

function runBP6() {
  var w    = gv('b_w', 32), h = gv('b_h', 15), d = gv('b_d', 18);
  var wood = gv('b_wood', 0.75);
  var sub  = window._lastSubSpec || {};
  var qty  = gv('t_qty', 1);
  var rmsW = gv('t_rms', 1000);
  var fs   = sub.fs  || gv('bp6_fs',  35);
  var qts  = sub.qts || gv('bp6_qts', 0.4);
  var vas  = sub.vas || gv('bp6_vas', 30);
  var sens = sub.sens || gv('t_sens', 85);
  var sz   = sub.sz  || gv('t_sz', 12);

  if (gv('bp6_fs',0))  fs  = gv('bp6_fs', fs);
  if (gv('bp6_qts',0)) qts = gv('bp6_qts', qts);
  if (gv('bp6_vas',0)) vas = gv('bp6_vas', vas);

  var rearVol  = gv('bp6_rear', 0)       || BP6.rearVol(qts, vas);
  var frontVol = gv('bp6_front', 0)      || BP6.frontVol(qts, vas);
  var rearFb   = gv('bp6_rear_tune', 0)  || BP6.rearTune(fs, qts);
  var frontFb  = gv('bp6_front_tune', 0) || BP6.frontTune(fs, qts);
  rearVol  = +rearVol.toFixed(3);
  frontVol = +frontVol.toFixed(3);
  rearFb   = +rearFb.toFixed(1);
  frontFb  = +frontFb.toFixed(1);

  var totalVol  = +(rearVol + frontVol).toFixed(3);
  var lowF3     = BP6.lowF3(fs, qts, frontFb);
  var highF3    = BP6.highF3(fs, qts, rearFb);
  var bandwidth = +(highF3 - lowF3).toFixed(1);
  var peakBoost = BP6.peakBoost(qts);
  var bandSens  = BP6.bandSens(sens, qts);
  var predSPL   = +(bandSens + 10*Math.log10(rmsW) + 7).toFixed(1);

  var rearRatio  = rearVol / totalVol;
  var rearDepth  = +(d * rearRatio * 0.88).toFixed(1);
  var frontDepth = +(d - rearDepth - wood).toFixed(1);

  var warning = qts > 0.55
    ? 'Qts ' + qts + ' is high for 6th order — bandpass works best with Qts 0.2-0.45. Consider 4th order or ported.'
    : null;
  var splNote = qts < 0.3
    ? 'Low Qts (' + qts + ') — this sub is a strong 6th order candidate for SPL competition.'
    : null;

  var big = '<div class="bn"><div class="bv fire">' + totalVol + '</div><div class="bl">TOTAL FT\u00b3</div></div>' +
    '<div class="bn"><div class="bv gr">' + lowF3 + ' - ' + highF3 + '</div><div class="bl">PASSBAND Hz</div></div>' +
    '<div class="bn"><div class="bv gd">' + predSPL + '</div><div class="bl">PRED SPL dB</div></div>';

  var rows =
    '<div class="rl"><span class="rk">REAR CHAMBER (ported)</span><span class="rv fire">' + rearVol + ' ft\u00b3</span></div>' +
    '<div class="rl"><span class="rk">REAR PORT TUNING</span><span class="rv gd">' + rearFb + ' Hz</span></div>' +
    '<div class="rl"><span class="rk">FRONT CHAMBER (ported)</span><span class="rv fire">' + frontVol + ' ft\u00b3</span></div>' +
    '<div class="rl"><span class="rk">FRONT PORT TUNING</span><span class="rv gd">' + frontFb + ' Hz</span></div>' +
    '<div class="rl"><span class="rk">TOTAL VOLUME</span><span class="rv">' + totalVol + ' ft\u00b3</span></div>' +
    '<div class="rl"><span class="rk">LOW F3</span><span class="rv ice">' + lowF3 + ' Hz</span></div>' +
    '<div class="rl"><span class="rk">HIGH F3</span><span class="rv ice">' + highF3 + ' Hz</span></div>' +
    '<div class="rl"><span class="rk">BANDWIDTH</span><span class="rv">' + bandwidth + ' Hz</span></div>' +
    '<div class="rl"><span class="rk">PEAK BOOST</span><span class="rv gd">+' + Math.max(0,peakBoost).toFixed(1) + ' dB over IB</span></div>' +
    '<div class="rl"><span class="rk">PRED SPL @ ' + rmsW + 'W</span><span class="rv gd">' + predSPL + ' dB</span></div>' +
    '<div class="rl"><span class="rk">REAR DEPTH (est.)</span><span class="rv">' + rearDepth + '"</span></div>' +
    '<div class="rl"><span class="rk">FRONT DEPTH (est.)</span><span class="rv">' + frontDepth + '"</span></div>';

  var tipHTML = '';
  if (warning) tipHTML += '<div class="ti warn">\u26a0\ufe0f ' + warning + '</div>';
  if (splNote) tipHTML += '<div class="ti ok">\u2705 ' + splNote + '</div>';
  tipHTML += '<div class="ti info" style="margin-top:6px;">\ud83c\udfc6 6th order bandpass is an SPL competition design. Both chambers are ported with different tuning frequencies. Extremely high output in a narrow band — not for daily listening. Tune carefully: wrong Fb values will destroy excursion limits.</div>';

  H('box-big', big);
  H('box-rows', rows + tipHTML);

  sv('bp6_rear', rearVol); sv('bp6_front', frontVol);
  sv('bp6_rear_tune', rearFb); sv('bp6_front_tune', frontFb);

  show('box-res', true);
  drawBP6('box-cv', w, h, d, rearDepth, frontDepth, wood, sz, qty);
}

function drawBP6(id, bW, bH, bD, rearD, frontD, woodT, sz, qty) {
  var canvas = document.getElementById(id);
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var cW = canvas.width = canvas.offsetWidth || 320;
  var cH = canvas.height = 200;
  ctx.clearRect(0, 0, cW, cH);

  var scale = Math.min((cW - 40) / bW, (cH - 40) / bH);
  var ox = (cW - bW*scale) / 2;
  var oy = (cH - bH*scale) / 2;
  var bWp = bW*scale, bHp = bH*scale;
  var rDp = rearD*scale, fDp = frontD*scale;
  var wTp = woodT*scale;

  ctx.fillStyle = '#1a1a1a';
  ctx.strokeStyle = 'rgba(255,208,0,0.6)';
  ctx.lineWidth = 2;
  ctx.fillRect(ox, oy, bWp, bHp);
  ctx.strokeRect(ox, oy, bWp, bHp);

  var divX = ox + rDp;
  ctx.strokeStyle = 'rgba(255,77,0,0.8)';
  ctx.lineWidth = wTp;
  ctx.beginPath(); ctx.moveTo(divX, oy); ctx.lineTo(divX, oy+bHp); ctx.stroke();

  // Sub hole
  var subR = (sz * 0.45 * scale) / 2;
  var subY = oy + bHp/2;
  ctx.fillStyle = '#111';
  ctx.strokeStyle = 'rgba(0,255,136,0.8)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(divX, subY, subR, 0, Math.PI*2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(0,255,136,0.5)';
  ctx.font = 'bold ' + Math.max(7, scale*1.2) + 'px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(sz + '"', divX, subY + 3);

  // Rear port (left side)
  var portW = 3*scale, portH = bHp*0.3;
  ctx.fillStyle = 'rgba(255,77,0,0.12)';
  ctx.strokeStyle = 'rgba(255,77,0,0.7)';
  ctx.lineWidth = 1;
  ctx.fillRect(ox, oy + (bHp-portH)/2, portW, portH);
  ctx.strokeRect(ox, oy + (bHp-portH)/2, portW, portH);

  // Front port (right side)
  ctx.fillStyle = 'rgba(0,204,255,0.12)';
  ctx.strokeStyle = 'rgba(0,204,255,0.7)';
  ctx.fillRect(ox+bWp-portW, oy+(bHp-portH)/2, portW, portH);
  ctx.strokeRect(ox+bWp-portW, oy+(bHp-portH)/2, portW, portH);

  // Labels
  ctx.fillStyle = 'rgba(255,77,0,0.7)';
  ctx.font = '7px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('PORTED', ox + rDp/2, oy + bHp*0.2);
  ctx.fillText('REAR', ox + rDp/2, oy + bHp*0.27);
  ctx.fillStyle = 'rgba(0,204,255,0.7)';
  ctx.fillText('PORTED', ox + rDp + fDp/2, oy + bHp*0.2);
  ctx.fillText('FRONT', ox + rDp + fDp/2, oy + bHp*0.27);
}

// ──────────────────────────────────────────────
// SEALED BOX
// ──────────────────────────────────────────────

// Master calculate dispatcher
function runBoxMaster() {
  if      (BOX_MODE === 'sealed') runBox();   // sealed uses 3D viewer only
  else if (BOX_MODE === 'bp4')    runBP4();
  else if (BOX_MODE === 'bp6')    runBP6();
  else                            runBox();
}


// REBASS ENGINE
async function processRebass() {
  var fileInput = document.getElementById('audio-upload');
  var status = document.getElementById('studio-status');
  var btn = document.getElementById('rb-process-btn');
  if (!fileInput || !fileInput.files || !fileInput.files[0]) {
    alert('Select an audio file first.');
    return;
  }
  btn.disabled = true;
  status.textContent = '⚙️ PROCESSING...';
  status.style.color = 'var(--gd)';

  try {
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) { alert('Web Audio API not supported in this browser.'); btn.disabled=false; return; }
    var audioCtx = new AudioCtx();

    var reader = new FileReader();
    reader.onload = async function(e) {
      try {
        var buffer = await audioCtx.decodeAudioData(e.target.result);
        var offCtx = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);

        var source = offCtx.createBufferSource();
        source.buffer = buffer;

        // Low-pass filter for bass boost
        var lp = offCtx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = parseFloat(document.getElementById('rb_freq').value) || 60;
        lp.Q.value = 1.4;

        // Gain for the boosted bass signal
        var boostGain = offCtx.createGain();
        boostGain.gain.value = Math.pow(10, (parseFloat(document.getElementById('rb_gain').value)||8) / 20);

        // Dry signal (original)
        var dryGain = offCtx.createGain();
        dryGain.gain.value = 0.75;

        // Compressor to prevent clipping
        var comp = offCtx.createDynamicsCompressor();
        comp.threshold.setValueAtTime(-10, offCtx.currentTime);
        comp.knee.setValueAtTime(6, offCtx.currentTime);
        comp.ratio.setValueAtTime(4, offCtx.currentTime);
        comp.attack.setValueAtTime(0.003, offCtx.currentTime);
        comp.release.setValueAtTime(0.25, offCtx.currentTime);

        // Routing: source -> dry -> comp -> destination
        //          source -> lp -> boost -> comp -> destination
        source.connect(dryGain);
        dryGain.connect(comp);
        source.connect(lp);
        lp.connect(boostGain);
        boostGain.connect(comp);
        comp.connect(offCtx.destination);

        source.start(0);
        var rendered = await offCtx.startRendering();
        var wavBlob = rebassBufferToWav(rendered);
        var url = URL.createObjectURL(wavBlob);

        var player = document.getElementById('audio-player');
        var dlLink = document.getElementById('rebass-download-link');
        var playerCard = document.getElementById('rebass-player-card');
        if (player) player.src = url;
        if (dlLink) {
          dlLink.href = url;
          dlLink.download = 'REBASSED_' + fileInput.files[0].name.replace(/\.[^/.]+$/, '') + '.wav';
        }
        if (playerCard) playerCard.style.display = 'block';
        status.textContent = '✅ DONE — ' + (rendered.duration).toFixed(1) + 's processed';
        status.style.color = 'var(--gr)';
      } catch(err) {
        status.textContent = '❌ ERROR: ' + err.message;
        status.style.color = 'var(--red)';
      }
      btn.disabled = false;
    };
    reader.onerror = function() {
      status.textContent = '❌ File read error';
      status.style.color = 'var(--red)';
      btn.disabled = false;
    };
    reader.readAsArrayBuffer(fileInput.files[0]);
  } catch(err) {
    status.textContent = '❌ ' + err.message;
    status.style.color = 'var(--red)';
    btn.disabled = false;
  }
}

function rebassBufferToWav(abuffer) {
  var numChan = abuffer.numberOfChannels;
  var length  = abuffer.length * numChan * 2 + 44;
  var buf     = new ArrayBuffer(length);
  var view    = new DataView(buf);
  var pos = 0;
  function u32(v){ view.setUint32(pos,v,true); pos+=4; }
  function u16(v){ view.setUint16(pos,v,true); pos+=2; }
  u32(0x46464952); u32(length-8); u32(0x45564157);
  u32(0x20746d66); u32(16); u16(1); u16(numChan);
  u32(abuffer.sampleRate); u32(abuffer.sampleRate*2*numChan);
  u16(numChan*2); u16(16); u32(0x61746164); u32(length-pos-4);
  for (var i=0; i<abuffer.length; i++) {
    for (var c=0; c<numChan; c++) {
      var s = Math.max(-1, Math.min(1, abuffer.getChannelData(c)[i]));
      view.setInt16(pos, s<0 ? s*0x8000 : s*0x7FFF, true);
      pos += 2;
    }
  }
  return new Blob([buf], {type:'audio/wav'});
}


// THERMAL CALCULATOR — amp + sub temperature rise
var THERMAL = {
  // Amp heat dissipation in watts
  ampHeat: function(rmsW, cls) {
    var eff = {d:0.85, ab:0.55, a:0.30}[cls] || 0.85;
    return +(rmsW * (1 - eff)).toFixed(0);
  },
  // Estimated amp case temp rise above ambient (°C)
  ampTempRise: function(heatW, hasFan, isVented) {
    var baseDeg = heatW * (isVented ? 0.08 : 0.13);
    if (hasFan) baseDeg *= 0.55;
    return +baseDeg.toFixed(1);
  },
  // Sub voice coil temp rise (simplified)
  // Based on power, VC resistance, duty cycle
  vcTempRise: function(rmsW, re, dutyCycle) {
    // P_dissipated = RMS * duty
    var pDiss = rmsW * (dutyCycle / 100);
    // Very rough model: 15°C per 100W dissipated through a 2" VC
    return +(pDiss * 0.15).toFixed(1);
  },
  rating: function(tempRise, limitC) {
    var pct = (tempRise / limitC) * 100;
    if (pct < 50) return {cls:'ok',  lbl:'COOL'};
    if (pct < 75) return {cls:'gd',  lbl:'WARM'};
    if (pct < 90) return {cls:'warn',lbl:'HOT'};
    return {cls:'bad', lbl:'DANGER'};
  }
};

function thermalRun() {
  var rmsW      = gv('th_rms', 1500);
  var cls       = gs('th_cls') || 'd';
  var hasFan    = gs('th_fan') === '1';
  var isVented  = gs('th_vent') === '1';
  var ambient   = gv('th_amb', 25);
  var duty      = gv('th_duty', 50);
  var subRe     = gv('th_re', 2);
  var subPe     = gv('th_pe', 1500);
  var qty       = gv('th_qty', 1);

  var ampHeat   = THERMAL.ampHeat(rmsW, cls);
  var ampRise   = THERMAL.ampTempRise(ampHeat, hasFan, isVented);
  var ampTemp   = +(ambient + ampRise).toFixed(1);
  var ampLimit  = 85; // typical class D MOSFET limit
  var ampRating = THERMAL.rating(ampRise, ampLimit - ambient);

  var vcRise    = THERMAL.vcTempRise(rmsW / qty, subRe, duty);
  var vcTemp    = +(ambient + vcRise + 20).toFixed(1); // +20 for enclosure
  var vcLimit   = 150; // typical VC adhesive limit
  var vcRating  = THERMAL.rating(vcTemp, vcLimit);

  var powerPerSub = +(rmsW / qty).toFixed(0);
  var thermalPct  = Math.round((rmsW / qty / subPe) * 100);

  H('thermal-out',
    '<div class="bn3" style="margin-bottom:12px;">' +
    '<div class="bn"><div class="bv ' + ampRating.cls + '">' + ampTemp + '\u00b0C</div><div class="bl">AMP CASE</div></div>' +
    '<div class="bn"><div class="bv ' + vcRating.cls  + '">' + vcTemp  + '\u00b0C</div><div class="bl">VC EST.</div></div>' +
    '<div class="bn"><div class="bv ' + (thermalPct>100?'red':thermalPct>80?'gd':'gr') + '">' + thermalPct + '%</div><div class="bl">THERMAL LOAD</div></div>' +
    '</div>' +
    '<div class="rl"><span class="rk">AMP HEAT DISSIPATED</span><span class="rv fire">' + ampHeat + 'W as heat</span></div>' +
    '<div class="rl"><span class="rk">AMP TEMP RISE</span><span class="rv ' + ampRating.cls + '">+' + ampRise + '\u00b0C \u2192 ' + ampTemp + '\u00b0C case</span></div>' +
    '<div class="rl"><span class="rk">AMP STATUS</span><span class="rv ' + ampRating.cls + '">' + ampRating.lbl + ' (' + ampLimit + '\u00b0C limit)</span></div>' +
    '<div class="rl"><span class="rk">POWER PER SUB</span><span class="rv">' + powerPerSub + 'W / sub</span></div>' +
    '<div class="rl"><span class="rk">THERMAL LOAD</span><span class="rv ' + (thermalPct>100?'red':'gr') + '">' + thermalPct + '% of Pe (' + subPe + 'W)</span></div>' +
    '<div class="rl"><span class="rk">VC TEMP ESTIMATE</span><span class="rv ' + vcRating.cls + '">' + vcTemp + '\u00b0C (limit ~150\u00b0C)</span></div>' +
    (ampRating.cls === 'bad' || ampRating.cls === 'warn' ?
      '<div class="ti bad" style="margin-top:6px;">\u274c Amp overheating risk. Add a fan, improve mounting surface contact, or reduce power.</div>' : '') +
    (thermalPct > 100 ?
      '<div class="ti bad">\u274c Sub running over rated power — reduce gain or add more subs.</div>' : '') +
    (hasFan ? '' : '<div class="ti info">\ud83d\udca1 Adding a cooling fan can cut amp case temp by up to 45%.</div>')
  );
  show('thermal-res', true);
}


// FUSE CALCULATOR
function fuseRun() {
  var rmsW   = gv('fuse_rms', 1500);
  var cls    = gs('fuse_cls') || 'd';
  var V      = 13.8;
  var eff    = {d:0.85, ab:0.55, a:0.30}[cls] || 0.85;
  var draw   = rmsW / (V * eff);
  var fuseA  = Math.ceil((draw * 1.25) / 5) * 5; // nearest 5A above 125% of draw
  var mainFuse = Math.ceil((draw * 1.4) / 10) * 10; // ANL at battery

  // Wire gauge recommendation
  var gauges = [
    {max:60,  gauge:'8 AWG',  label:'8 AWG'},
    {max:125, gauge:'4 AWG',  label:'4 AWG'},
    {max:200, gauge:'2 AWG',  label:'2 AWG'},
    {max:300, gauge:'1/0 AWG',label:'1/0 AWG'},
    {max:400, gauge:'2/0 AWG',label:'2/0 AWG'},
    {max:500, gauge:'4/0 AWG',label:'4/0 AWG'},
  ];
  var rec = gauges.find(function(g){ return draw <= g.max; }) || gauges[gauges.length-1];

  var big3Done = gs('fuse_big3') === '1';

  H('fuse-out',
    '<div class="bn3" style="margin-bottom:12px;">' +
    '<div class="bn"><div class="bv fire">' + draw.toFixed(1) + 'A</div><div class="bl">CURRENT DRAW</div></div>' +
    '<div class="bn"><div class="bv gd">' + fuseA + 'A</div><div class="bl">AMP FUSE</div></div>' +
    '<div class="bn"><div class="bv ice">' + mainFuse + 'A</div><div class="bl">ANL FUSE</div></div>' +
    '</div>' +
    '<div class="rl"><span class="rk">CURRENT DRAW</span><span class="rv fire">' + draw.toFixed(1) + 'A @ ' + V + 'V</span></div>' +
    '<div class="rl"><span class="rk">AMP FUSE (at amp)</span><span class="rv gd">' + fuseA + 'A — blade or mini ANL</span></div>' +
    '<div class="rl"><span class="rk">ANL FUSE (at battery)</span><span class="rv ice">' + mainFuse + 'A — within 18" of battery</span></div>' +
    '<div class="rl"><span class="rk">FUSE QTY (single run)</span><span class="rv">1x ANL at battery + 1x at amp</span></div>' +
    '<div class="rl"><span class="rk">WIRE RECOMMENDATION</span><span class="rv fire">' + rec.label + ' OFC</span></div>' +
    '<div class="rl"><span class="rk">BIG 3 NEEDED</span><span class="rv ' + (draw>100?'red':'gr') + '">' + (draw>100?'YES — upgrade required':'Optional below 100A draw') + '</span></div>' +
    (big3Done
      ? '<div class="ti ok">\u2705 Big 3 done — your charging system is ready for this amp.</div>'
      : (draw > 100 ? '<div class="ti bad">\u274c Big 3 NOT done — voltage sag will cause cutouts at ' + draw.toFixed(0) + 'A draw. Do Big 3 first.</div>'
          : '<div class="ti info">\ud83d\udca1 Big 3 upgrade always improves performance even below 100A draw.</div>')
    )
  );
  show('fuse-res', true);
}


// VISUAL WIRE DIAGRAM — SVG based
function drawWireDiagram(id, qty, ohms, isDVC, coilMode, subMode) {
  var el = document.getElementById(id);
  if (!el) return;

  qty = Math.min(qty, 4); // cap visual at 4 for readability
  var svgW = Math.min(el.offsetWidth || 320, 360);
  var svgH = qty <= 2 ? 200 : 280;

  var subW = 60, subH = 70;
  var cols = qty <= 2 ? qty : 2;
  var rows = Math.ceil(qty / cols);
  var gapX = (svgW - cols * subW) / (cols + 1);
  var gapY = (svgH - rows * subH - 40) / (rows + 1);

  var subs = [];
  for (var i = 0; i < qty; i++) {
    var col = i % cols;
    var row = Math.floor(i / cols);
    subs.push({
      x: gapX + col * (subW + gapX),
      y: 30 + gapY + row * (subH + gapY),
      i: i
    });
  }

  var lines = [];
  var labels = [];

  // Draw connection lines based on wiring mode
  // For DVC: each sub has 2 terminals top (pos coil1, pos coil2) and 2 bottom (neg)
  subs.forEach(function(s) {
    // Sub body
    lines.push('<rect x="' + s.x + '" y="' + s.y + '" width="' + subW + '" height="' + subH + '" rx="8" fill="#1a1a1a" stroke="rgba(0,204,255,0.5)" stroke-width="1.5"/>');
    // Speaker icon
    lines.push('<circle cx="' + (s.x+subW/2) + '" cy="' + (s.y+subH/2) + '" r="18" fill="none" stroke="rgba(0,204,255,0.3)" stroke-width="1.5"/>');
    lines.push('<circle cx="' + (s.x+subW/2) + '" cy="' + (s.y+subH/2) + '" r="7" fill="rgba(0,204,255,0.1)" stroke="rgba(0,204,255,0.4)" stroke-width="1"/>');
    labels.push('<text x="' + (s.x+subW/2) + '" y="' + (s.y+subH-6) + '" text-anchor="middle" font-family="Share Tech Mono,monospace" font-size="7" fill="rgba(0,204,255,0.6)">SUB '+(s.i+1)+'</text>');

    if (isDVC) {
      // Left coil terminal top
      lines.push('<circle cx="' + (s.x+12) + '" cy="' + s.y + '" r="4" fill="var(--fire)" stroke="#fff" stroke-width="1"/>');
      lines.push('<circle cx="' + (s.x+subW-12) + '" cy="' + s.y + '" r="4" fill="var(--fire)" stroke="#fff" stroke-width="1"/>');
      // Left coil terminal bottom
      lines.push('<circle cx="' + (s.x+12) + '" cy="' + (s.y+subH) + '" r="4" fill="#444" stroke="#aaa" stroke-width="1"/>');
      lines.push('<circle cx="' + (s.x+subW-12) + '" cy="' + (s.y+subH) + '" r="4" fill="#444" stroke="#aaa" stroke-width="1"/>');
      // DVC label
      labels.push('<text x="' + (s.x+subW/2) + '" y="' + (s.y+14) + '" text-anchor="middle" font-family="Share Tech Mono,monospace" font-size="7" fill="rgba(255,208,0,0.8)">DVC ' + ohms + '\u03a9</text>');
    } else {
      // SVC: one pos top, one neg bottom, centered
      lines.push('<circle cx="' + (s.x+subW/2-10) + '" cy="' + s.y + '" r="4" fill="var(--fire)" stroke="#fff" stroke-width="1"/>');
      lines.push('<circle cx="' + (s.x+subW/2+10) + '" cy="' + s.y + '" r="4" fill="#444" stroke="#aaa" stroke-width="1"/>');
      labels.push('<text x="' + (s.x+subW/2) + '" y="' + (s.y+14) + '" text-anchor="middle" font-family="Share Tech Mono,monospace" font-size="7" fill="rgba(255,208,0,0.8)">SVC ' + ohms + '\u03a9</text>');
    }
  });

  // Amp connection label at top
  var finalOhms = (function() {
    try {
      var r = BF.wire(qty, ohms, isDVC, coilMode, subMode);
      return r.fl;
    } catch(e) { return '?'; }
  })();

  var ampY = 14;
  var ampLabel = '<rect x="' + (svgW/2-50) + '" y="4" width="100" height="18" rx="4" fill="rgba(255,77,0,0.15)" stroke="rgba(255,77,0,0.5)" stroke-width="1"/>';
  var ampText  = '<text x="' + (svgW/2) + '" y="17" text-anchor="middle" font-family="Share Tech Mono,monospace" font-size="8" fill="var(--fire)" font-weight="700">AMP \u2192 ' + finalOhms + '\u03a9 FINAL LOAD</text>';

  el.innerHTML = '<svg width="' + svgW + '" height="' + svgH + '">' +
    ampLabel + ampText +
    lines.join('') + labels.join('') +
    '</svg>';
}

// Hook wireRun to also update SVG diagram
function refreshWireDiagram() {
  var qty    = gv('w_qty', 1);
  var ohms   = gv('w_ohms', 2);
  var isDVC  = gs('w_dvc') === 'dvc';
  drawWireDiagram('wire-svg-diag', qty, ohms, isDVC, ST.cm, ST.sm);
}


// SUB HOLE COORDINATES on cut sheet
function getSubHoleCoords(bW, bH, bD, woodT, qty, subSz, isDbl) {
  var iW  = +(bW - woodT*2).toFixed(2);
  var iH  = +(bH - woodT * (isDbl ? 3 : 2)).toFixed(2);
  var cutD = +(subSz * 0.5).toFixed(2); // cutout diameter ≈ 0.95 * nominal
  var coords = [];

  if (qty === 1) {
    coords.push({
      sub: 1,
      fromLeft:  +(iW / 2).toFixed(2),
      fromBottom:+(iH / 2).toFixed(2),
      cutoutD:    cutD,
      note: 'Center of baffle'
    });
  } else if (qty === 2) {
    coords.push({sub:1, fromLeft:+(iW/3).toFixed(2),       fromBottom:+(iH/2).toFixed(2), cutoutD:cutD, note:'1/3 from left'});
    coords.push({sub:2, fromLeft:+(iW*2/3).toFixed(2),     fromBottom:+(iH/2).toFixed(2), cutoutD:cutD, note:'2/3 from left'});
  } else if (qty === 3) {
    for (var i=0; i<3; i++) coords.push({sub:i+1, fromLeft:+(iW*(i+1)/4).toFixed(2), fromBottom:+(iH/2).toFixed(2), cutoutD:cutD, note:'Even spacing'});
  } else if (qty === 4) {
    var positions = [[1,1],[2,1],[1,2],[2,2]]; // col, row
    var cW = iW/2, cH = iH/2;
    positions.forEach(function(p,i){
      coords.push({sub:i+1, fromLeft:+(cW*(p[0]-0.5)).toFixed(2), fromBottom:+(cH*(p[1]-0.5)).toFixed(2), cutoutD:cutD, note:'Grid layout'});
    });
  } else {
    // For more subs, vertical stack or grid
    for (var j=0; j<Math.min(qty,6); j++) {
      coords.push({sub:j+1, fromLeft:+(iW*(j+1)/(qty+1)).toFixed(2), fromBottom:+(iH/2).toFixed(2), cutoutD:cutD, note:'Even spacing'});
    }
  }
  return coords;
}


// PORT LAYOUT MEASUREMENTS
function getPortLayout(bW, bH, bD, woodT, portW, portPos) {
  var iW = +(bW - woodT*2).toFixed(2);
  var iH = +(bH - woodT*2).toFixed(2);
  var iD = +(bD - woodT*2).toFixed(2);

  var layout = {portW: portW, portH: +(iH * 0.7).toFixed(2)};

  if (portPos === 'right' || portPos === 'left') {
    var side = portPos === 'right' ? 'RIGHT side panel' : 'LEFT side panel';
    layout.panel = side;
    layout.fromEdge = +(woodT + 0.5).toFixed(2);
    layout.fromBottom = +(iH * 0.15).toFixed(2);
    layout.note = 'Port slot flush against ' + side.toLowerCase() + ', ' + layout.fromBottom + '" up from floor';
  } else if (portPos === 'center') {
    layout.panel = 'FRONT BAFFLE — center slot';
    layout.fromLeft = +((iW - portW) / 2).toFixed(2);
    layout.fromBottom = +(iH * 0.1).toFixed(2);
    layout.note = 'Centered on baffle, ' + layout.fromBottom + '" up from floor';
  } else if (portPos === 'dual') {
    layout.panel = 'BOTH SIDE PANELS';
    layout.fromEdge = +(woodT + 0.5).toFixed(2);
    layout.fromBottom = +(iH * 0.15).toFixed(2);
    layout.note = 'Mirror image — one port each side, same height';
  }
  return layout;
}

// Enhance cutsRun to add sub hole coords and port layout
function cutsRunExtended() {
  // Get current box/sub info
  var bW  = gv('cs_w', 32), bH = gv('cs_h', 15), bD = gv('cs_d', 18);
  var mk  = gs('cs_mat') || 'mdf75';
  var t   = (MATS[mk] && MATS[mk].t) || 0.75;
  var ns  = parseInt(gs('cs_ns')) || 1;
  var isDbl = (parseInt(gs('cs_db'))||0) === 1;
  var sz  = gv('t_sz', 12);
  var portW = gv('cs_pw', 3);
  var portPos = gs('b_port_pos') || 'right';

  // Sub hole coordinates
  var holes = getSubHoleCoords(bW, bH, bD, t, ns, sz, isDbl);
  var holeHTML = '<div class="card" style="margin-top:10px;">' +
    '<div class="ct fire">// SUB HOLE COORDINATES — FRONT BAFFLE</div>' +
    '<p style="font-size:10px;color:var(--mu2);margin-bottom:8px;line-height:1.5;">Measure from the inside face of the baffle after cutting to size. Use these as your drill/jig center points.</p>' +
    holes.map(function(h) {
      return '<div style="background:var(--stone3);border-radius:8px;padding:10px;margin-bottom:6px;">' +
        '<div style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--fire);margin-bottom:5px;">SUB ' + h.sub + ' HOLE</div>' +
        '<div class="rl"><span class="rk">FROM LEFT EDGE</span><span class="rv fire">' + h.fromLeft + '"</span></div>' +
        '<div class="rl"><span class="rk">FROM BOTTOM EDGE</span><span class="rv fire">' + h.fromBottom + '"</span></div>' +
        '<div class="rl"><span class="rk">CUTOUT DIAMETER</span><span class="rv gd">' + h.cutoutD + '"</span></div>' +
        '<div style="font-family:Share Tech Mono,monospace;font-size:8px;color:var(--mu2);margin-top:4px;">' + h.note + '</div>' +
        '</div>';
    }).join('') +
    '<div class="ti info">&#128161; Mark your center point first, verify with a compass or circle jig before cutting.</div>' +
    '</div>';

  // Port layout
  var portLayout = getPortLayout(bW, bH, bD, t, portW, portPos);
  var portHTML = '<div class="card" style="margin-top:10px;">' +
    '<div class="ct gd">// PORT LAYOUT</div>' +
    '<div class="rl"><span class="rk">PANEL</span><span class="rv gd">' + portLayout.panel + '</span></div>' +
    '<div class="rl"><span class="rk">PORT SLOT WIDTH</span><span class="rv">' + portLayout.portW + '"</span></div>' +
    '<div class="rl"><span class="rk">PORT SLOT HEIGHT</span><span class="rv">' + portLayout.portH + '"</span></div>' +
    (portLayout.fromLeft !== undefined
      ? '<div class="rl"><span class="rk">FROM LEFT EDGE</span><span class="rv fire">' + portLayout.fromLeft + '"</span></div>'
      : '<div class="rl"><span class="rk">FROM SIDE EDGE</span><span class="rv fire">' + portLayout.fromEdge + '"</span></div>') +
    '<div class="rl"><span class="rk">FROM BOTTOM EDGE</span><span class="rv fire">' + portLayout.fromBottom + '"</span></div>' +
    '<div style="font-family:Share Tech Mono,monospace;font-size:8px;color:var(--mu2);margin-top:6px;line-height:1.6;">' + portLayout.note + '</div>' +
    '</div>';

  // Inject into cut-list after existing content
  var existing = document.getElementById('sub-hole-coords');
  if (existing) existing.remove();
  var portExisting = document.getElementById('port-layout-coords');
  if (portExisting) portExisting.remove();

  var cutListEl = document.getElementById('cut-list');
  if (cutListEl) {
    var holeDiv = document.createElement('div');
    holeDiv.id = 'sub-hole-coords';
    holeDiv.innerHTML = holeHTML;
    cutListEl.parentNode.insertBefore(holeDiv, cutListEl.nextSibling);

    var portDiv = document.createElement('div');
    portDiv.id = 'port-layout-coords';
    portDiv.innerHTML = portHTML;
    holeDiv.parentNode.insertBefore(portDiv, holeDiv.nextSibling);
  }
}


function toggleCollapse(id, btn) {
  var el = document.getElementById(id);
  if (!el) return;
  var isOpen = btn.getAttribute('data-open') === '1';
  el.style.display = isOpen ? 'none' : 'block';
  btn.setAttribute('data-open', isOpen ? '0' : '1');
  btn.innerHTML = (isOpen ? '> SHOW' : 'v HIDE') + btn.innerHTML.replace(/^[>v] (SHOW|HIDE) /,'');
}

// HAIR TRICK ENGINE
// Finds the most violent build that fits in your specific vehicle

function hairTrickRun() {
  var vehKey = gs('ht_veh') || 'standard';
  var budget  = gs('ht_budget') || 'any';
  var goal    = gs('ht_goal')   || 'loud';
  var rmsW    = gv('ht_rms',   1500);

  // Get trunk dimensions from TK_DB first, fall back to VDB
  var trunk = null;
  var tkEntry = tkLookupByVehKey(vehKey);
  var vdbEntry = VDB[vehKey] || VDB.standard;

  var maxW, maxH, maxD, cabinGain;
  if (tkEntry && tkEntry.interior) {
    maxW = tkEntry.interior.w || 36;
    maxH = tkEntry.interior.h || 16;
    maxD = tkEntry.interior.d || 22;
    cabinGain = vdbEntry.cabinGain || 7;
    trunk = 'MEASURED (' + tkEntry.v.year + ' ' + tkEntry.v.make + ' ' + tkEntry.v.model + ')';
  } else {
    maxW = vdbEntry.maxW || 36;
    maxH = vdbEntry.maxH || 16;
    maxD = vdbEntry.maxD || 22;
    cabinGain = vdbEntry.cabinGain || 7;
    trunk = 'ESTIMATED — verify before build';
  }

  var wood = 0.75;
  var maxBoxVol = +((maxW - wood*2) * (maxH - wood*2) * (maxD - wood*2) / 1728 * 0.92).toFixed(3);

  // Determine max sub size that fits based on trunk height
  var maxSubSz = 18;
  if (maxH < 12) maxSubSz = 8;
  else if (maxH < 14) maxSubSz = 10;
  else if (maxH < 16) maxSubSz = 12;
  else if (maxH < 20) maxSubSz = 15;

  // Find best subs from database
  // Score = sens + log10(rms)*10 + (xmax>0 ? xmax*0.5 : 0)
  var candidates = [];
  Object.keys(SUB_DB).forEach(function(bk) {
    SUB_DB[bk].forEach(function(s) {
      if (!s.sz || parseInt(s.sz) > maxSubSz) return;
      if (budget === 'mid' && s.rms > 3000) return;
      if (budget === 'entry' && s.rms > 1500) return;

      // How many subs fit side by side?
      var subCutout = parseInt(s.sz) + 1; // rough cutout diameter
      var maxQty = Math.floor((maxW - wood*2) / (subCutout + 1));
      maxQty = Math.min(maxQty, goal === 'spl' ? 4 : 2);
      maxQty = Math.max(1, maxQty);

      for (var q = maxQty; q >= 1; q--) {
        var volNeeded = (s.rec_vol || 1.0) * q;
        if (volNeeded > maxBoxVol * 1.1) continue;

        var volActual = Math.min(volNeeded, maxBoxVol);
        var tune = s.rec_tune || 35;
        var predSPL = +(s.sens + 10*Math.log10(rmsW * q) + cabinGain).toFixed(1);

        var score = predSPL;
        if (goal === 'sq') score = predSPL - Math.abs(tune - 38) * 0.5;
        if (goal === 'spl') score = predSPL + (q * 2);

        candidates.push({
          brand: BRAND_NAMES[bk] || bk,
          bk: bk,
          model: s.model,
          sz: parseInt(s.sz),
          rms: s.rms,
          sens: s.sens,
          qty: q,
          vol: +volActual.toFixed(2),
          tune: tune,
          spl: predSPL,
          score: +score.toFixed(1),
          rec_vol: s.rec_vol,
          fs: s.fs,
          qts: s.qts
        });
        break; // take best qty for this sub
      }
    });
  });

  if (candidates.length === 0) {
    H('ht-result', '<div class="ti bad">&#9888; No subs found for this vehicle and criteria. Try a larger vehicle or lower budget tier.</div>');
    show('ht-res', true);
    return;
  }

  // Sort by score descending
  candidates.sort(function(a, b) { return b.score - a.score; });

  var top = candidates[0];
  var top3 = candidates.slice(0, 3);

  // Hair trick threshold
  var isHairTrick = top.spl >= 140;
  var isBoneStock = top.spl < 130;
  var tier = top.spl >= 155 ? 'COMPETITION' : top.spl >= 145 ? 'EXTREME' : top.spl >= 140 ? 'HAIR TRICK' : top.spl >= 135 ? 'FEELS IT' : 'STREET';
  var tierColor = top.spl >= 155 ? 'red' : top.spl >= 145 ? 'fire' : top.spl >= 140 ? 'gd' : top.spl >= 135 ? 'gr' : 'mu2';

  var headerHTML =
    '<div style="text-align:center;padding:20px 10px;background:var(--stone3);border-radius:12px;margin-bottom:12px;border:1px solid rgba(255,77,0,.2);">' +
    '<div style="font-family:Black Ops One,cursive;font-size:40px;color:var(--' + tierColor + ');line-height:1;">' + top.spl + ' dB</div>' +
    '<div style="font-family:Share Tech Mono,monospace;font-size:10px;color:var(--' + tierColor + ');letter-spacing:3px;margin-top:4px;">' + tier + '</div>' +
    '<div style="font-family:Share Tech Mono,monospace;font-size:9px;color:var(--mu);margin-top:6px;">' + trunk + '</div>' +
    (isHairTrick ? '<div style="font-size:20px;margin-top:8px;">\ud83d\udca8 HAIR TRICK TERRITORY</div>' : '') +
    '</div>';

  var buildHTML =
    '<div class="card" style="border-color:rgba(255,208,0,.3);margin-bottom:8px;">' +
    '<div class="ct gd">// RECOMMENDED BUILD</div>' +
    '<div class="rl"><span class="rk">SUB</span><span class="rv fire">' + top.qty + 'x ' + top.brand + ' ' + top.model + '</span></div>' +
    '<div class="rl"><span class="rk">SIZE</span><span class="rv">' + top.sz + '" — fits in ' + maxH + '" trunk height</span></div>' +
    '<div class="rl"><span class="rk">QUANTITY</span><span class="rv fire">' + top.qty + ' sub' + (top.qty > 1 ? 's' : '') + '</span></div>' +
    '<div class="rl"><span class="rk">RMS RATING</span><span class="rv">' + top.rms + 'W each — ' + (top.rms * top.qty) + 'W total</span></div>' +
    '<div class="rl"><span class="rk">RECOMMENDED BOX</span><span class="rv gd">' + top.vol + ' ft\u00b3 @ ' + top.tune + ' Hz</span></div>' +
    '<div class="rl"><span class="rk">AMP POWER USED</span><span class="rv">' + rmsW + 'W @ your amp</span></div>' +
    '<div class="rl"><span class="rk">CABIN GAIN</span><span class="rv">+' + cabinGain + ' dB (' + (vdbEntry.name || vehKey) + ')</span></div>' +
    '<div class="rl"><span class="rk">MAX TRUNK BOX</span><span class="rv ice">' + maxBoxVol + ' ft\u00b3 in this trunk</span></div>' +
    '<div class="rl"><span class="rk">PREDICTED SPL</span><span class="rv ' + tierColor + '">' + top.spl + ' dB peak</span></div>' +
    '</div>';

  // Alternatives
  var altHTML = '';
  if (top3.length > 1) {
    altHTML = '<div style="font-family:Share Tech Mono,monospace;font-size:8px;color:var(--mu);letter-spacing:2px;margin-bottom:6px;">RUNNER-UP OPTIONS</div>';
    altHTML += top3.slice(1).map(function(c) {
      return '<div class="rl" style="cursor:pointer;">' +
        '<span class="rk">' + c.qty + 'x ' + c.brand + ' ' + c.model + ' ' + c.sz + '"</span>' +
        '<span class="rv ' + (c.spl>=140?'gd':'gr') + '">' + c.spl + ' dB</span>' +
        '</div>';
    }).join('');
  }

  // Button to load this build
  var loadBtn = '<button class="btn gr-btn" style="background:var(--gr);color:#000;margin-top:10px;width:100%;" ' +
    'onclick="hairTrickLoad(' + JSON.stringify(top).replace(/"/g, '&quot;') + ')">' +
    '\u26a1 LOAD THIS BUILD TO FORGE' +
    '</button>';

  H('ht-result', headerHTML + buildHTML + altHTML + loadBtn);
  show('ht-res', true);
}

function hairTrickLoad(build) {
  sv('t_sz', build.sz);
  sv('t_rms', build.rms);
  sv('t_qty', build.qty);
  sv('t_sens', build.sens);
  sv('b_disp', 0.10);
  sv('af_vol', build.vol);
  sv('af_tune', build.tune);
  sv('sp_w', build.rms);
  sv('sp_s', build.sens);
  sv('sp_n', build.qty);
  lsync();
  sw('forge');
  showForgeToast('\u26a1 HAIR TRICK BUILD LOADED');
}


// PRO QUOTE PDF GENERATOR
var QUOTE_STATE = {
  company:  '',
  labor:    150,
  markup:   15,
  wood:     42,
  caulk:    8,
  screws:   6,
  wire:     25,
  misc:     20,
};

function quoteRun() {
  QUOTE_STATE.company = gs('q_company') || 'Low End Labs';
  QUOTE_STATE.labor   = gv('q_labor',   150);
  QUOTE_STATE.markup  = gv('q_markup',  15);
  QUOTE_STATE.wood    = gv('q_wood',    42);
  QUOTE_STATE.caulk   = gv('q_caulk',  8);
  QUOTE_STATE.screws  = gv('q_screws', 6);
  QUOTE_STATE.wire    = gv('q_wire',   25);
  QUOTE_STATE.misc    = gv('q_misc',   20);

  var mk       = gs('cs_mat') || 'mdf75';
  var mat      = MATS[mk];
  var dims     = {w:gv('cs_w',32), h:gv('cs_h',15), d:gv('cs_d',18)};
  var sheets   = BF.cuts(dims, mat.t, false, gv('cs_ns',1)||1).sheets;
  var woodCost = sheets * QUOTE_STATE.wood;
  var matTotal = woodCost + QUOTE_STATE.caulk + QUOTE_STATE.screws + QUOTE_STATE.wire + QUOTE_STATE.misc;
  var markupAmt= +(matTotal * QUOTE_STATE.markup / 100).toFixed(2);
  var subtotal = +(matTotal + markupAmt + QUOTE_STATE.labor).toFixed(2);
  var tax      = +(subtotal * 0.08).toFixed(2); // 8% est.
  var total    = +(subtotal + tax).toFixed(2);

  H('quote-out',
    '<div class="rl"><span class="rk">Wood (' + sheets + ' sheets ' + mat.label + ')</span><span class="rv fire">$' + woodCost.toFixed(2) + '</span></div>' +
    '<div class="rl"><span class="rk">Caulk / Silicone</span><span class="rv">$' + QUOTE_STATE.caulk.toFixed(2) + '</span></div>' +
    '<div class="rl"><span class="rk">Screws / Hardware</span><span class="rv">$' + QUOTE_STATE.screws.toFixed(2) + '</span></div>' +
    '<div class="rl"><span class="rk">Wire / Power Supply</span><span class="rv">$' + QUOTE_STATE.wire.toFixed(2) + '</span></div>' +
    '<div class="rl"><span class="rk">Misc Materials</span><span class="rv">$' + QUOTE_STATE.misc.toFixed(2) + '</span></div>' +
    '<div class="rl" style="border-top:1px solid rgba(255,255,255,.1);margin-top:4px;padding-top:4px;"><span class="rk">Materials Subtotal</span><span class="rv gd">$' + matTotal.toFixed(2) + '</span></div>' +
    '<div class="rl"><span class="rk">Markup (' + QUOTE_STATE.markup + '%)</span><span class="rv gd">$' + markupAmt + '</span></div>' +
    '<div class="rl"><span class="rk">Labor</span><span class="rv fire">$' + QUOTE_STATE.labor.toFixed(2) + '</span></div>' +
    '<div class="rl"><span class="rk">Subtotal</span><span class="rv">$' + subtotal + '</span></div>' +
    '<div class="rl"><span class="rk">Est. Tax (8%)</span><span class="rv">$' + tax + '</span></div>' +
    '<div class="rl" style="background:rgba(0,255,136,.06);border-color:rgba(0,255,136,.2);"><span class="rk" style="color:var(--gr);font-weight:700;">TOTAL QUOTE</span><span class="rv gr" style="font-size:18px;font-weight:700;">$' + total + '</span></div>'
  );
  show('quote-res', true);

  // Store for PDF
  window._quoteData = {company: QUOTE_STATE.company, woodCost, matTotal, markupAmt, labor: QUOTE_STATE.labor, subtotal, tax, total, mat, sheets, dims};
}

function exportQuotePDF() {
  if (!window.jspdf) { alert('jsPDF not loaded.'); return; }
  var q = window._quoteData;
  if (!q) { alert('Run the quote calculator first.'); return; }

  var {jsPDF} = window.jspdf;
  var doc = new jsPDF({unit:'mm', format:'letter'});

  // Background
  doc.setFillColor(8,8,8); doc.rect(0,0,216,279,'F');

  // Header
  doc.setTextColor(255,77,0); doc.setFont('helvetica','bold'); doc.setFontSize(24);
  doc.text(q.company || 'Low End Labs', 20, 25);

  doc.setFontSize(10); doc.setTextColor(150,150,150); doc.setFont('helvetica','normal');
  doc.text('INSTALLATION QUOTE', 20, 33);
  doc.text('Date: ' + new Date().toLocaleDateString(), 130, 25);
  doc.text('Quote #: BF-' + Date.now().toString().slice(-6), 130, 33);

  doc.setDrawColor(255,77,0); doc.setLineWidth(0.5); doc.line(20,37,196,37);

  // Customer section
  var y = 45;
  doc.setTextColor(255,208,0); doc.setFont('helvetica','bold'); doc.setFontSize(9);
  doc.text('// VEHICLE & SYSTEM', 20, y); y += 8;

  var veh = VDB[gs('t_veh')||'standard'];
  var rows = [
    ['Vehicle', veh ? veh.name : 'Customer Vehicle'],
    ['Subwoofer', gv('t_qty',2) + 'x ' + gv('t_sz',12) + '" Sub — ' + gv('t_rms',1000) + 'W each'],
    ['Enclosure', q.dims.w + '" x ' + q.dims.h + '" x ' + q.dims.d + '" ' + q.mat.label + ' box'],
    ['Material', q.mat.label + ' — ' + q.sheets + ' sheet' + (q.sheets>1?'s':'') + ' required'],
  ];

  rows.forEach(function(r) {
    doc.setTextColor(120,120,120); doc.setFont('helvetica','normal'); doc.setFontSize(9);
    doc.text(r[0], 20, y);
    doc.setTextColor(220,220,220); doc.setFont('helvetica','bold');
    doc.text(r[1], 90, y); y += 7;
  });

  y += 5;
  doc.setDrawColor(60,60,60); doc.setLineWidth(0.2); doc.line(20, y, 196, y); y += 8;

  // Materials breakdown
  doc.setTextColor(0,204,255); doc.setFont('helvetica','bold'); doc.setFontSize(9);
  doc.text('// MATERIALS', 20, y); y += 8;

  var matRows = [
    ['Wood (' + q.sheets + ' sheet' + (q.sheets>1?'s':'') + ')', '$' + q.woodCost.toFixed(2)],
    ['Caulk / Silicone sealant', '$' + QUOTE_STATE.caulk.toFixed(2)],
    ['Screws & hardware', '$' + QUOTE_STATE.screws.toFixed(2)],
    ['Wire & power supply', '$' + QUOTE_STATE.wire.toFixed(2)],
    ['Miscellaneous', '$' + QUOTE_STATE.misc.toFixed(2)],
  ];

  matRows.forEach(function(r) {
    doc.setTextColor(150,150,150); doc.setFont('helvetica','normal'); doc.setFontSize(9);
    doc.text(r[0], 25, y);
    doc.setTextColor(220,220,220);
    doc.text(r[1], 175, y, {align:'right'}); y += 6;
  });

  y += 3;
  doc.setDrawColor(60,60,60); doc.line(20, y, 196, y); y += 6;

  // Pricing
  doc.setTextColor(255,208,0); doc.setFont('helvetica','bold'); doc.setFontSize(9);
  doc.text('// PRICING', 20, y); y += 8;

  var priceRows = [
    ['Materials subtotal', '$' + q.matTotal.toFixed(2), [180,180,180]],
    ['Markup (' + QUOTE_STATE.markup + '%)', '$' + q.markupAmt.toFixed(2), [180,180,180]],
    ['Labor', '$' + q.labor.toFixed(2), [255,77,0]],
    ['Subtotal', '$' + q.subtotal.toFixed(2), [220,220,220]],
    ['Estimated tax (8%)', '$' + q.tax.toFixed(2), [150,150,150]],
  ];

  priceRows.forEach(function(r) {
    doc.setTextColor(120,120,120); doc.setFont('helvetica','normal'); doc.setFontSize(9);
    doc.text(r[0], 25, y);
    doc.setTextColor(r[2][0], r[2][1], r[2][2]); doc.setFont('helvetica','bold');
    doc.text(r[1], 175, y, {align:'right'}); y += 7;
  });

  // Total box
  y += 3;
  doc.setFillColor(20,40,20); doc.roundedRect(20, y, 176, 16, 3, 3, 'F');
  doc.setDrawColor(0,255,136); doc.roundedRect(20, y, 176, 16, 3, 3, 'S');
  doc.setTextColor(0,255,136); doc.setFont('helvetica','bold'); doc.setFontSize(14);
  doc.text('TOTAL: $' + q.total.toFixed(2), 108, y+11, {align:'center'});
  y += 24;

  // Cut sheet summary
  if (y < 230) {
    doc.setTextColor(0,255,136); doc.setFont('helvetica','bold'); doc.setFontSize(9);
    doc.text('// ENCLOSURE CUT LIST', 20, y); y += 8;
    var cs = BF.cuts(q.dims, q.mat.t, false, gv('cs_ns',1)||1);
    cs.panels.forEach(function(p) {
      doc.setTextColor(150,150,150); doc.setFont('helvetica','normal'); doc.setFontSize(8);
      doc.text(p.name + (p.note?' ('+p.note+')':'') + '   QTY ' + p.qty, 25, y);
      doc.setTextColor(200,200,200);
      doc.text(p.w.toFixed(2) + '" x ' + p.d.toFixed(2) + '"', 175, y, {align:'right'}); y += 6;
      if (y > 255) { doc.addPage(); doc.setFillColor(8,8,8); doc.rect(0,0,216,279,'F'); y = 20; }
    });
  }

  // Footer
  doc.setTextColor(50,50,50); doc.setFontSize(7); doc.setFont('helvetica','normal');
  doc.text('Generated by BassForge \u2022 Low End Labs \u2022 All prices are estimates and subject to change.', 108, 272, {align:'center'});

  var fname = (q.company || 'BassForge').replace(/\s+/g,'_') + '_Quote_' + new Date().toISOString().slice(0,10) + '.pdf';
  doc.save(fname);
}


// LED LIGHTING CALCULATOR
function ledRun() {
  var bW    = gv('led_w',  32);
  var bH    = gv('led_h',  15);
  var bD    = gv('led_d',  18);
  var sides = gs('led_sides') || 'interior';

  // Perimeter of each face
  var front  = 2 * (bW + bH);    // front baffle
  var back   = front;              // back panel
  var top    = 2 * (bW + bD);
  var sideP  = 2 * (bH + bD);    // side panels x2

  var totalIn;
  if (sides === 'interior') {
    // Run inside perimeter of all 4 visible faces
    totalIn = front + top + sideP * 2;
  } else if (sides === 'front') {
    totalIn = front;
  } else if (sides === 'full') {
    totalIn = front + back + top + sideP * 2;
  } else {
    totalIn = front;
  }

  var totalFt = +(totalIn / 12).toFixed(1);
  var totalM  = +(totalIn * 0.0254).toFixed(1);

  // Standard LED strip: 60 LEDs/m, ~5W/m, 12V
  var wattsNeeded = +(totalM * 5).toFixed(1);
  var ampsNeeded  = +(wattsNeeded / 12).toFixed(1);

  // Router bit recommendation
  // For hidden channel: 3/8" (9.5mm) router bit gives tight fit for 10mm LED strip
  // Channel depth: 5/16" (8mm) — strip sits flush or slightly recessed
  var routerBit   = '3/8" (9.5mm) straight bit';
  var channelDepth = '5/16" (8mm) depth';
  var channelNote  = 'Strip width is 10mm — 3/8" channel gives ~0.5mm clearance each side. Tight enough to hide the strip, easy to remove if needed.';

  if (gv('led_strip_w', 10) > 12) {
    routerBit    = '1/2" (12.7mm) straight bit';
    channelDepth = '3/8" (9.5mm) depth';
    channelNote  = 'Wider strip — use 1/2" bit. Route a test pass on scrap first.';
  }

  H('led-out',
    '<div class="bn3" style="margin-bottom:10px;">' +
    '<div class="bn"><div class="bv ice">' + totalFt + ' ft</div><div class="bl">STRIP LENGTH</div></div>' +
    '<div class="bn"><div class="bv gd">' + wattsNeeded + 'W</div><div class="bl">POWER DRAW</div></div>' +
    '<div class="bn"><div class="bv fire">' + ampsNeeded + 'A</div><div class="bl">CURRENT</div></div>' +
    '</div>' +
    '<div class="rl"><span class="rk">TOTAL STRIP NEEDED</span><span class="rv ice">' + totalFt + ' ft (' + totalM + 'm)</span></div>' +
    '<div class="rl"><span class="rk">COVERAGE</span><span class="rv">' + totalIn.toFixed(0) + '" total perimeter</span></div>' +
    '<div class="rl"><span class="rk">POWER DRAW</span><span class="rv gd">' + wattsNeeded + 'W @ 12V</span></div>' +
    '<div class="rl"><span class="rk">CURRENT DRAW</span><span class="rv fire">' + ampsNeeded + 'A — use ' + (ampsNeeded > 5 ? '10A' : '5A') + ' inline fuse</span></div>' +
    '<div style="background:var(--stone3);border-radius:9px;padding:12px;margin-top:8px;">' +
    '<div style="font-family:Share Tech Mono,monospace;font-size:8px;color:var(--gd);letter-spacing:2px;margin-bottom:8px;">ROUTER BIT — HIDDEN CHANNEL</div>' +
    '<div class="rl"><span class="rk">BIT SIZE</span><span class="rv gd">' + routerBit + '</span></div>' +
    '<div class="rl"><span class="rk">CHANNEL DEPTH</span><span class="rv gd">' + channelDepth + '</span></div>' +
    '<div style="font-family:Share Tech Mono,monospace;font-size:8px;color:var(--mu2);margin-top:6px;line-height:1.6;">' + channelNote + '</div>' +
    '</div>' +
    '<div class="ti info" style="margin-top:8px;">\ud83d\udca1 Buy 15% extra strip for corners and waste. Route channel on back face of panels before assembly — much easier than after.</div>'
  );
  show('led-res', true);
}

function updateHairTrickStatus(){ /* hair trick lives in HAIR tab only */ }

function applyHairTrick() {
  var netVol = gv("b_w",32) > 0 ? parseFloat((document.getElementById("box-big")||{textContent:"2"}).textContent)||2 : 2;
  var mk = parseFloat(gs("b_wood"))||0.75;
  var iH = gv("b_h", 15) - mk*2;
  var targetPortArea = netVol * 18;
  var portH = Math.max(6, +(iH * 0.7).toFixed(1));
  var portW = +(targetPortArea / portH).toFixed(1);
  portW = Math.max(2, Math.min(portW, gv("b_w",32) - 4));
  sv("b_pw", portW);
  sv("b_pl", 24);
  // Do NOT call tuneSliderMove or sw() - just recalculate box in place
  runBoxMaster();
}

// 3D BOX VIEWER + AR GENERATOR
// Uses Three.js for live 3D preview, GLTFExporter for AR model

var _3D = {
  scene: null, camera: null, renderer: null, boxGroup: null,
  animFrame: null, isDragging: false, lastX: 0, lastY: 0,
  rotX: 0.4, rotY: -0.6, zoom: 1.0,
  dims: {w:32, h:15, d:18}, subSz: 12, qty: 1, portW: 3, portH: 12, isDbl: false
};

function init3DViewer() {
  var canvas = document.getElementById('box-3d-canvas');
  if (!canvas) return;
  if (!window.THREE) return;

  var THREE = window.THREE;
  var W = canvas.offsetWidth || 320;
  var H = 260;
  canvas.width = W; canvas.height = H;

  _3D.scene    = new THREE.Scene();
  _3D.scene.background = new THREE.Color(0x0a0a0a);

  _3D.camera   = new THREE.PerspectiveCamera(45, W/H, 0.01, 100);
  _3D.camera.position.set(0, 0.2, 1.8);

  _3D.renderer = new THREE.WebGLRenderer({canvas: canvas, antialias: true, alpha: true});
  _3D.renderer.setSize(W, H);
  _3D.renderer.shadowMap.enabled = true;

  // Lighting
  var ambient = new THREE.AmbientLight(0xffffff, 0.4);
  _3D.scene.add(ambient);
  var key = new THREE.DirectionalLight(0xFF8800, 0.8);
  key.position.set(1, 2, 2);
  _3D.scene.add(key);
  var fill = new THREE.DirectionalLight(0x0088FF, 0.3);
  fill.position.set(-2, 0, 1);
  _3D.scene.add(fill);
  var rim = new THREE.DirectionalLight(0x00FF88, 0.2);
  rim.position.set(0, -1, -2);
  _3D.scene.add(rim);

  _3D.boxGroup = new THREE.Group();
  _3D.scene.add(_3D.boxGroup);

  // Touch/mouse controls
  canvas.addEventListener('mousedown',  function(e){ _3D.isDragging=true; _3D.lastX=e.clientX; _3D.lastY=e.clientY; });
  canvas.addEventListener('mousemove',  function(e){ if(!_3D.isDragging)return; _3D.rotY+=(e.clientX-_3D.lastX)*0.008; _3D.rotX+=(e.clientY-_3D.lastY)*0.008; _3D.lastX=e.clientX; _3D.lastY=e.clientY; });
  canvas.addEventListener('mouseup',    function(){ _3D.isDragging=false; });
  canvas.addEventListener('mouseleave', function(){ _3D.isDragging=false; });
  canvas.addEventListener('wheel',      function(e){ _3D.zoom = Math.max(0.4, Math.min(3.0, _3D.zoom + e.deltaY*0.001)); e.preventDefault(); }, {passive:false});
  canvas.addEventListener('touchstart', function(e){ _3D.isDragging=true; _3D.lastX=e.touches[0].clientX; _3D.lastY=e.touches[0].clientY; }, {passive:true});
  canvas.addEventListener('touchmove',  function(e){ if(!_3D.isDragging||!e.touches[0])return; _3D.rotY+=(e.touches[0].clientX-_3D.lastX)*0.01; _3D.rotX+=(e.touches[0].clientY-_3D.lastY)*0.01; _3D.lastX=e.touches[0].clientX; _3D.lastY=e.touches[0].clientY; }, {passive:true});
  canvas.addEventListener('touchend',   function(){ _3D.isDragging=false; });

  update3DBox();
  animate3D();
}

function update3DBox() {
  if (!_3D.scene || !window.THREE) return;
  var THREE = window.THREE;

  // Clear old box
  while (_3D.boxGroup.children.length) {
    var m = _3D.boxGroup.children[0];
    if (m.geometry) m.geometry.dispose();
    if (m.material) m.material.dispose();
    _3D.boxGroup.remove(m);
  }

  var d = _3D.dims;
  var scale = 0.8 / Math.max(d.w, d.h, d.d); // normalize to fit view
  var w = d.w * scale, h = d.h * scale, depth = d.d * scale;

  // MDF material — dark wood look
  var mdfMat = new THREE.MeshStandardMaterial({
    color: 0x2a1f14, roughness: 0.85, metalness: 0.0
  });
  var mdfEdge = new THREE.MeshStandardMaterial({
    color: 0x1a1208, roughness: 0.9, metalness: 0.0
  });
  var subMat = new THREE.MeshStandardMaterial({
    color: 0x111111, roughness: 0.6, metalness: 0.3,
    side: THREE.DoubleSide
  });
  var portMat = new THREE.MeshStandardMaterial({
    color: 0x001a0d, roughness: 0.5, metalness: 0.1,
    transparent: true, opacity: 0.8
  });
  var fireMat = new THREE.MeshStandardMaterial({
    color: 0xFF4D00, roughness: 0.3, metalness: 0.5,
    emissive: 0xFF2200, emissiveIntensity: 0.2
  });

  var wood = 0.75 * scale;

  // Build box panels
  var panels = [
    // top, bottom, left, right, back
    {size:[w,wood,depth], pos:[0, h/2-wood/2, 0]},
    {size:[w,wood,depth], pos:[0,-h/2+wood/2, 0]},
    {size:[wood,h,depth], pos:[-w/2+wood/2,0, 0]},
    {size:[wood,h,depth], pos:[ w/2-wood/2,0, 0]},
    {size:[w,h,wood],     pos:[0,0,-depth/2+wood/2]},
  ];

  panels.forEach(function(p) {
    var geo  = new THREE.BoxGeometry(p.size[0], p.size[1], p.size[2]);
    var mesh = new THREE.Mesh(geo, mdfMat);
    mesh.position.set(p.pos[0], p.pos[1], p.pos[2]);
    mesh.castShadow = true;
    _3D.boxGroup.add(mesh);
  });

  // Front baffle with sub holes
  var baffleGeo = new THREE.BoxGeometry(w, h, wood);
  var baffle = new THREE.Mesh(baffleGeo, _3D.isDbl ? fireMat : mdfMat);
  baffle.position.set(0, 0, depth/2 - wood/2);
  _3D.boxGroup.add(baffle);

  // Sub holes — circles on front face
  var subR = (_3D.subSz * 0.47 * scale) / 2;
  var qty  = Math.min(_3D.qty, 4);
  for (var i = 0; i < qty; i++) {
    var subX = qty === 1 ? 0 : (w * (i / (qty-1) - 0.5) * 0.6);
    var subGeo = new THREE.CylinderGeometry(subR, subR, wood*1.2, 32);
    subGeo.rotateX(Math.PI/2);
    var subMesh = new THREE.Mesh(subGeo, subMat);
    subMesh.position.set(subX, 0, depth/2);
    _3D.boxGroup.add(subMesh);

    // Speaker cone visual
    var coneGeo = new THREE.ConeGeometry(subR*0.85, subR*0.4, 32);
    coneGeo.rotateX(-Math.PI/2);
    var coneMesh = new THREE.Mesh(coneGeo, new THREE.MeshStandardMaterial({color:0x222222, roughness:0.8}));
    coneMesh.position.set(subX, 0, depth/2 + wood*0.3);
    _3D.boxGroup.add(coneMesh);

    // Dust cap
    var capGeo = new THREE.SphereGeometry(subR*0.25, 16, 8, 0, Math.PI*2, 0, Math.PI/2);
    capGeo.rotateX(Math.PI);
    var capMesh = new THREE.Mesh(capGeo, new THREE.MeshStandardMaterial({color:0x333333}));
    capMesh.position.set(subX, 0, depth/2 + wood*0.3 + subR*0.18);
    _3D.boxGroup.add(capMesh);
  }

  // Port slot — right side panel opening
  var portW2 = _3D.portW * scale;
  var portH2 = _3D.portH * scale;
  var portGeo = new THREE.BoxGeometry(wood*1.5, portH2, portW2);
  var portMesh = new THREE.Mesh(portGeo, portMat);
  portMesh.position.set(w/2, -h/4, 0);
  _3D.boxGroup.add(portMesh);

  // Port glow
  var portGlow = new THREE.Mesh(
    new THREE.BoxGeometry(wood*0.5, portH2*0.9, portW2*0.8),
    new THREE.MeshStandardMaterial({color:0x00FF88, emissive:0x00FF88, emissiveIntensity:0.6, transparent:true, opacity:0.3})
  );
  portGlow.position.set(w/2 + wood*0.3, -h/4, 0);
  _3D.boxGroup.add(portGlow);

  // Dimension text labels (sprites)
  addDimLabel(w+0.05, 0, 0, d.w+'"', 0xFF4D00);
  addDimLabel(0, h/2+0.05, 0, d.h+'"', 0xFFD000);
  addDimLabel(0, 0, -depth/2-0.05, d.d+'"', 0x00CCFF);

  // Center the group
  _3D.boxGroup.position.set(0, 0, 0);
  _3D.boxGroup.rotation.x = _3D.rotX;
  _3D.boxGroup.rotation.y = _3D.rotY;
}

function addDimLabel(x, y, z, text, color) {
  if (!window.THREE) return;
  var THREE = window.THREE;
  var canvas2 = document.createElement('canvas');
  canvas2.width = 128; canvas2.height = 40;
  var ctx = canvas2.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0)';
  ctx.clearRect(0,0,128,40);
  ctx.font = 'bold 22px Share Tech Mono, monospace';
  ctx.fillStyle = '#' + color.toString(16).padStart(6,'0');
  ctx.textAlign = 'center';
  ctx.fillText(text, 64, 28);
  var tex = new THREE.CanvasTexture(canvas2);
  var mat = new THREE.SpriteMaterial({map:tex, transparent:true});
  var sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.25, 0.08, 1);
  sprite.position.set(x, y, z);
  _3D.boxGroup.add(sprite);
}

function animate3D() {
  _3D.animFrame = requestAnimationFrame(animate3D);
  if (!_3D.renderer || !_3D.scene || !_3D.camera) return;

  // Apply rotation and zoom
  if (_3D.boxGroup) {
    _3D.boxGroup.rotation.x = _3D.rotX;
    _3D.boxGroup.rotation.y = _3D.rotY;
    _3D.boxGroup.scale.setScalar(_3D.zoom);
  }

  // Slow auto-rotate when not dragging
  if (!_3D.isDragging) {
    _3D.rotY += 0.003;
  }

  _3D.renderer.render(_3D.scene, _3D.camera);
}

function refresh3DBox(w, h, d, subSz, qty, portW, portH, isDbl) {
  _3D.dims   = {w:w, h:h, d:d};
  _3D.subSz  = subSz  || 12;
  _3D.qty    = qty    || 1;
  _3D.portW  = portW  || 3;
  _3D.portH  = portH  || (h - 1.5);
  _3D.isDbl  = isDbl  || false;
  if (_3D.scene) {
    update3DBox();
  } else {
    // Three.js not loaded yet — try loading it
    if (!window.THREE) {
      load3DLibrary();
    }
  }
}

function load3DLibrary() {
  if (window.THREE) { init3DViewer(); return; }
  var s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  s.onload = function() {
    init3DViewer();
  };
  document.head.appendChild(s);
}

// GENERATE GLB FOR AR
function generateARModel() {
  var btn = document.getElementById('ar-generate-btn');
  var status = document.getElementById('ar-status');
  if (status) { status.textContent = 'GENERATING MODEL...'; status.style.color='var(--gd)'; }
  if (btn) btn.disabled = true;

  if (!window.THREE) {
    load3DLibrary();
    setTimeout(generateARModel, 1500);
    return;
  }

  var THREE = window.THREE;
  var d = _3D.dims;
  var scale = 0.0254; // inches to meters for real-world AR scale

  // Build a simple scene for export
  var scene = new THREE.Scene();
  var w = d.w*scale, h = d.h*scale, depth = d.d*scale;
  var wood = 0.75*scale;

  var mdfMat = new THREE.MeshStandardMaterial({color:0x3a2a18, roughness:0.85});
  var subMat = new THREE.MeshStandardMaterial({color:0x111111, roughness:0.6});

  // Outer box (simplified solid box for AR — no CSG needed)
  var boxGeo = new THREE.BoxGeometry(w, h, depth);
  var box = new THREE.Mesh(boxGeo, mdfMat);
  scene.add(box);

  // Sub circles on front
  var qty = Math.min(_3D.qty, 4);
  var subR = (_3D.subSz * 0.47 * scale) / 2;
  for (var i=0; i<qty; i++) {
    var subX = qty===1 ? 0 : (w*(i/(qty-1)-0.5)*0.6);
    var cGeo = new THREE.CylinderGeometry(subR, subR, wood, 32);
    cGeo.rotateX(Math.PI/2);
    var cMesh = new THREE.Mesh(cGeo, subMat);
    cMesh.position.set(subX, 0, depth/2);
    scene.add(cMesh);
  }

  // Try to export as GLB
  var exporterScript = document.getElementById('gltf-exporter-script');
  if (!exporterScript) {
    var s2 = document.createElement('script');
    s2.id = 'gltf-exporter-script';
    s2.src = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/exporters/GLTFExporter.js';
    s2.onload = function() { doGLBExport(scene, btn, status); };
    s2.onerror = function() {
      // Fallback: use model-viewer without AR, just show 3D
      if (status) { status.textContent = 'AR unavailable — showing 3D only'; status.style.color='var(--mu)'; }
      if (btn) btn.disabled = false;
    };
    document.head.appendChild(s2);
  } else {
    doGLBExport(scene, btn, status);
  }
}

function doGLBExport(scene, btn, status) {
  if (!window.THREE || !window.THREE.GLTFExporter) {
    if (status) { status.textContent = 'GLB export unavailable in this browser'; status.style.color='var(--mu)'; }
    if (btn) btn.disabled = false;
    return;
  }
  var exporter = new window.THREE.GLTFExporter();
  exporter.parse(scene, function(glb) {
    var blob = new Blob([glb], {type:'model/gltf-binary'});
    var url  = URL.createObjectURL(blob);
    var mv   = document.getElementById('box-model-viewer');
    if (mv) {
      mv.setAttribute('src', url);
      mv.style.display = 'block';
      var d2 = _3D.dims;
      mv.setAttribute('scale', (d2.w*0.0254) + ' ' + (d2.h*0.0254) + ' ' + (d2.d*0.0254));
      if (status) { status.textContent = 'MODEL READY \u2014 TAP VIEW IN AR'; status.style.color='var(--gr)'; }
    }
    if (btn) btn.disabled = false;
  }, {binary: true});
}

function toggle3D2D(){
  var c3d = document.getElementById("box-3d-canvas");
  var c2d = document.getElementById("box-2d-card");
  var btn = document.getElementById("toggle-3d-btn");
  if(!c3d||!c2d||!btn) return;
  var showing3d = c3d.style.display !== "none";
  c3d.style.display  = showing3d ? "none" : "block";
  c2d.style.display  = showing3d ? "block" : "none";
  btn.textContent = showing3d ? "3D" : "2D";
}

// NEW SUBS DATABASE UI
// Replaces old brand/model dropdowns with search + brand buttons + model cards

var DB_STATE = {
  brand: '',
  modelIdx: -1,
  sizeFilter: '',
  search: ''
};

function dbSearch(val) {
  DB_STATE.search = (val || '').trim().toLowerCase();
  DB_STATE.brand  = '';
  DB_STATE.modelIdx = -1;
  // Deactivate brand buttons
  document.querySelectorAll('.db-brand-btn').forEach(function(b){ b.classList.remove('active'); });
  dbRenderModels();
}

function dbSelectBrand(bk, el) {
  DB_STATE.brand = bk;
  DB_STATE.modelIdx = -1;
  DB_STATE.search = '';
  // Clear search
  var si = document.getElementById('db-search-input');
  if (si) si.value = '';
  // Highlight button
  document.querySelectorAll('.db-brand-btn').forEach(function(b){ b.classList.remove('active'); });
  if (el) el.classList.add('active');
  dbRenderModels();
}

function dbSetSizeFilter(sz, el) {
  DB_STATE.sizeFilter = DB_STATE.sizeFilter === sz ? '' : sz;
  document.querySelectorAll('.db-size-btn').forEach(function(b){ b.classList.remove('active'); });
  if (DB_STATE.sizeFilter && el) el.classList.add('active');
  dbRenderModels();
}

function dbRenderBrands() {
  var groups = [
    {label:'ESTABLISHED', brands:['ct','sundown','dc','dd','jl','rf','skar','ab','fi','ace']},
    {label:'SPL / COMPETITION', brands:['d4s','avatar','skyhigh','orion','psi','deafbonce','rs','ia','sq','massive','b2','gz']}
  ];
  var html2 = groups.map(function(g) {
    var btns = g.brands.map(function(bk) {
      var count = (SUB_DB[bk]||[]).length;
      var name  = (BRAND_NAMES[bk]||bk).replace(' Audio','').replace(' Car','').replace(' Sounds','');
      return '<button class="db-brand-btn' + (DB_STATE.brand===bk?' active':'') + '" ' +
        'onclick="dbSelectBrand(\'' + bk + '\',this)" ' +
        'style="flex:1;min-width:calc(25% - 4px);padding:8px 4px;background:var(--stone3);border:1px solid ' +
        (DB_STATE.brand===bk?'var(--fire)':'var(--stone4)') + ';border-radius:8px;cursor:pointer;text-align:center;">' +
        getBrandLogo(bk) +'<div style="font-family:Russo One,sans-serif;font-size:9px;color:' + (DB_STATE.brand===bk?'var(--fire)':'var(--wh)') + ';font-weight:700;line-height:1.3;margin-top:3px;">' + name + '</div>' +
        '<div style="font-family:Share Tech Mono,monospace;font-size:7px;color:var(--mu);">' + count + ' models</div>' +
        '</button>';
    }).join('');
    return '<div style="font-family:Share Tech Mono,monospace;font-size:7px;color:var(--mu);letter-spacing:2px;margin-bottom:6px;margin-top:8px;">' + g.label + '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:4px;">' + btns + '</div>';
  }).join('');
  H('db-brand-grid', html2);
}

function dbRenderModels() {
  var subs = [];
  var searchQ = DB_STATE.search;
  var sz = DB_STATE.sizeFilter;

  if (searchQ) {
    // Search across all brands
    Object.keys(SUB_DB).forEach(function(bk) {
      (SUB_DB[bk]||[]).forEach(function(s, i) {
        var haystack = ((BRAND_NAMES[bk]||bk) + ' ' + s.model + ' ' + s.sz + 'inch').toLowerCase();
        if (haystack.indexOf(searchQ) > -1) {
          subs.push({s:s, bk:bk, i:i});
        }
      });
    });
  } else if (DB_STATE.brand) {
    (SUB_DB[DB_STATE.brand]||[]).forEach(function(s, i) {
      subs.push({s:s, bk:DB_STATE.brand, i:i});
    });
  }

  // Apply size filter
  if (sz) {
    subs = subs.filter(function(e){ return String(e.s.sz) === String(sz); });
  }

  if (!subs.length && !searchQ && !DB_STATE.brand) {
    H('db-model-list', '<div style="font-family:Share Tech Mono,monospace;font-size:10px;color:var(--mu);text-align:center;padding:20px;">SELECT A BRAND OR SEARCH</div>');
    show('db-spec-card', false);
    return;
  }

  if (!subs.length) {
    H('db-model-list', '<div style="font-family:Share Tech Mono,monospace;font-size:10px;color:var(--mu);text-align:center;padding:20px;">NO RESULTS</div>');
    return;
  }

  var colors = {ct:'var(--fire)',sundown:'var(--gd)',dc:'var(--ice)',dd:'var(--gr)',jl:'#0090ff',
    rf:'#cc0000',skar:'var(--pu)',ab:'var(--fire)',fi:'var(--gr)',ace:'var(--ice)',
    d4s:'var(--gd)',avatar:'var(--pu)',skyhigh:'#00ddff',orion:'#ff6600',psi:'var(--gr)',
    deafbonce:'#cc2200',rs:'var(--ice)',ia:'var(--red)',sq:'var(--gd)',massive:'var(--fire)',
    b2:'#ff8800',gz:'#44ff88'};

  var html2 = subs.map(function(e) {
    var s   = e.s, bk = e.bk, i = e.i;
    var col = colors[bk] || 'var(--fire)';
    var bName = (BRAND_NAMES[bk]||bk);
    var isActive = DB_STATE.brand === bk && DB_STATE.modelIdx === i;
    var powerTier = s.rms >= 3000 ? 'SPL' : s.rms >= 1500 ? 'COMP' : s.rms >= 800 ? 'DAILY' : 'STREET';
    var tierColor = s.rms >= 3000 ? 'var(--red)' : s.rms >= 1500 ? 'var(--fire)' : s.rms >= 800 ? 'var(--gd)' : 'var(--gr)';

    return '<div class="db-model-card' + (isActive?' db-model-active':'') + '" ' +
      'onclick="dbSelectModel(\'' + bk + '\',' + i + ',this)" ' +
      'style="background:' + (isActive?'rgba(255,77,0,.08)':'var(--stone3)') + ';border:1px solid ' +
      (isActive?'var(--fire)':'var(--stone4)') + ';border-radius:10px;padding:12px;margin-bottom:6px;cursor:pointer;transition:all .15s;">' +

      // Top row: brand + tier badge
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
      '<div style="font-family:Share Tech Mono,monospace;font-size:8px;color:' + col + ';letter-spacing:1px;">' + bName.toUpperCase() + '</div>' +
      '<span style="font-family:Share Tech Mono,monospace;font-size:7px;padding:2px 7px;border-radius:20px;background:rgba(255,255,255,.05);color:' + tierColor + ';border:1px solid ' + tierColor + ';">' + powerTier + '</span>' +
      '</div>' +

      // Model name
      '<div style="font-family:Russo One,sans-serif;font-size:16px;color:var(--wh);margin-bottom:8px;letter-spacing:.5px;">' + s.model + '</div>' +

      // Stats row
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:4px;">' +
      stat3d(s.sz + '"', 'SIZE', col) +
      stat3d(s.rms + 'W', 'RMS', 'var(--fire)') +
      stat3d(s.sens + 'dB', 'SENS', 'var(--gd)') +
      stat3d(s.fs + 'Hz', 'Fs', 'var(--ice)') +
      '</div>' +

      // Expanded specs if active
      (isActive ?
        '<div style="margin-top:10px;border-top:1px solid rgba(255,255,255,.07);padding-top:10px;">' +
        '<div class="rl"><span class="rk">IMPEDANCE</span><span class="rv ice">' + s.ohms + '\u03a9 ' + (s.dvc?'DVC':'SVC') + '</span></div>' +
        '<div class="rl"><span class="rk">DISPLACEMENT</span><span class="rv">' + s.disp + ' ft\u00b3</span></div>' +
        (s.qts ? '<div class="rl"><span class="rk">Qts</span><span class="rv">' + s.qts + '</span></div>' : '') +
        (s.vas ? '<div class="rl"><span class="rk">Vas</span><span class="rv">' + s.vas + ' L</span></div>' : '') +
        '<div class="rl" style="background:rgba(0,255,136,.05);border-color:rgba(0,255,136,.15);"><span class="rk">REC BOX</span><span class="rv gr">' + s.rec_vol + ' ft\u00b3 @ ' + s.rec_tune + ' Hz</span></div>' +
        '<button class="btn gr-btn" style="width:100%;margin-top:8px;background:var(--fire);color:#fff;" onclick="event.stopPropagation();dbLoadFromCard(\'' + bk + '\',' + i + ')">&#9889; LOAD TO FORGE</button>' +
        (s.qts && s.vas ? '<button class="btn outline sm" style="width:100%;margin-top:6px;" onclick="event.stopPropagation();dbShowTSFromCard(\'' + bk + '\',' + i + ')">&#x1F4CA; TS BOX MATH</button>' : '') +
        '</div>'
      : '') +
      '</div>';
  }).join('');

  H('db-model-list', html2);
}

function stat3d(val, label, color) {
  return '<div style="background:var(--stone4);border-radius:6px;padding:6px 4px;text-align:center;">' +
    '<div style="font-family:Russo One,sans-serif;font-size:11px;color:' + color + ';letter-spacing:.5px;">' + val + '</div>' +
    '<div style="font-family:Share Tech Mono,monospace;font-size:6px;color:var(--mu);letter-spacing:1px;margin-top:2px;">' + label + '</div>' +
    '</div>';
}

function dbSelectModel(bk, idx, el) {
  var wasActive = DB_STATE.brand === bk && DB_STATE.modelIdx === idx;
  DB_STATE.brand    = bk;
  DB_STATE.modelIdx = wasActive ? -1 : idx;
  // Update hidden selects for compatibility
  sv('db_brand', bk);
  sv('db_model', idx);
  dbRenderModels();
  if (!wasActive) dbRenderBrands();
  // Show or hide the spec card
  if (!wasActive) {
    dbPopulateSpecCard(bk, idx);
  } else {
    show('db-spec-card', false);
  }
}

function dbPopulateSpecCard(bk, idx) {
  var subs = SUB_DB[bk];
  if (!subs || idx < 0 || !subs[idx]) { show('db-spec-card', false); return; }
  var s = subs[idx];
  var bName = BRAND_NAMES[bk] || bk;
  H('db-big',
    '<div class="bn"><div class="bv fire">' + s.rms + '</div><div class="bl">RMS WATTS</div></div>' +
    '<div class="bn"><div class="bv gd">' + s.sens + '</div><div class="bl">SENS dB</div></div>' +
    '<div class="bn"><div class="bv ice">' + s.sz + '"</div><div class="bl">SIZE</div></div>'
  );
  H('db-rows',
    '<div class="rl"><span class="rk">BRAND</span><span class="rv fire">' + bName + '</span></div>' +
    '<div class="rl"><span class="rk">MODEL</span><span class="rv">' + s.model + '</span></div>' +
    '<div class="rl"><span class="rk">IMPEDANCE</span><span class="rv ice">' + s.ohms + '\u03a9 ' + (s.dvc ? 'DVC' : 'SVC') + '</span></div>' +
    '<div class="rl"><span class="rk">DISPLACEMENT</span><span class="rv">' + s.disp + ' ft\u00b3</span></div>' +
    (s.qts ? '<div class="rl"><span class="rk">Qts</span><span class="rv">' + s.qts + '</span></div>' : '') +
    (s.vas ? '<div class="rl"><span class="rk">Vas</span><span class="rv">' + s.vas + ' L</span></div>' : '') +
    '<div class="rl" style="background:rgba(0,255,136,.05);border-color:rgba(0,255,136,.15);"><span class="rk">REC BOX</span><span class="rv gr">' + s.rec_vol + ' ft\u00b3 @ ' + s.rec_tune + ' Hz</span></div>'
  );
  show('db-spec-card', true);
}

function dbLoadFromCard(bk, idx) {
  var s = (SUB_DB[bk] || [])[idx];
  if (!s) return;
  window._lastSubSpec = s;
  sv('t_rms',  s.rms);
  sv('t_sz',   s.sz);
  sv('t_ohms', s.ohms || 2);
  sv('t_dvc',  s.dvc ? 'dvc' : 'svc');
  sv('t_sens', s.sens);
  sv('b_disp', s.disp);
  if (s.rec_vol  != null) sv('af_vol',  s.rec_vol);
  if (s.rec_tune != null) sv('af_tune', s.rec_tune);
  sv('sp_s', s.sens);
  sv('sp_w', s.rms);
  if (s.fs)  { sv('bp4_fs',  s.fs);  sv('bp6_fs',  s.fs);  }
  if (s.qts) { sv('bp4_qts', s.qts); sv('bp6_qts', s.qts); }
  if (s.vas) { sv('bp4_vas', s.vas); sv('bp6_vas', s.vas); }
  lsync();
  sw('forge');
  setTimeout(function() { runBoxMaster(); showForgeToast('\u26a1 ' + s.model + ' LOADED'); }, 80);
}

function dbShowTSFromCard(bk, idx) {
  sv('db_brand', bk);
  sv('db_model', idx);
  dbShowTS();
  // Show TS results
  var tsEl = document.getElementById('db-ts-results');
  if (tsEl) {
    tsEl.style.display = 'block';
    tsEl.scrollIntoView({behavior:'smooth'});
  }
}

// Override dbRenderAll to use new UI
function toggleBrandsAccordion(){
  var g=document.getElementById("db-brand-grid");
  var a=document.getElementById("db-brands-arrow");
  var b=document.getElementById("db-brands-btn");
  if(!g)return;
  var open=g.style.display!=="none";
  g.style.display=open?"none":"block";
  if(a) a.textContent=open?"\u25BC BRANDS":"\u25B2 BRANDS";
  if(b) b.style.borderBottomColor=open?"transparent":"var(--fire)";
  if(!open && typeof dbRenderBrands==="function") dbRenderBrands();
}

function tuneSliderMove(_hz){ runBoxMaster(); }
function setBig3(hasBig3, el) {
  document.querySelectorAll("#big3_no,#big3_yes").forEach(function(b){ b.classList.remove("on"); });
  if (el) el.classList.add("on");
  var status = document.getElementById("b3status");
  if (hasBig3) {
    if (status) { status.textContent = "\u2705 Big 3 complete \u2014 charging system ready for high current draw."; status.style.color = "var(--gr)"; }
    var fb = document.getElementById("fuse_big3"); if (fb) { fb.value = "1"; fuseRun(); }
  } else {
    if (status) { status.textContent = "Big 3: Alt\u2192Batt \u2022 Batt\u2192Chassis \u2022 Alt\u2192Chassis \u2014 match your power wire gauge."; status.style.color = "var(--mu)"; }
    var fb2 = document.getElementById("fuse_big3"); if (fb2) { fb2.value = "0"; fuseRun(); }
  }
  // Also feed into elec calc
  elecRun();
}

function setAltMode(mode, el) {
  document.querySelectorAll("#alt_single,#alt_dual").forEach(function(b){ b.classList.remove("on"); });
  if (el) el.classList.add("on");
  var dualField = document.getElementById("alt-dual-field");
  if (dualField) dualField.style.display = mode === "dual" ? "block" : "none";
  if (mode === "dual") {
    // Force Big 3 on
    var b3yes = document.getElementById("big3_yes");
    var b3no  = document.getElementById("big3_no");
    if (b3yes && b3no) { b3no.classList.remove("on"); b3yes.classList.add("on"); }
    var fb = document.getElementById("fuse_big3"); if (fb) fb.value = "1";
  }
  elecRun();
}

function getBrandLogo(bk) {
  var name = BRAND_NAMES[bk] || bk;
  var initials = name.split(' ').map(function(w){ return w[0]||''; }).join('').toUpperCase().slice(0,3);
  var colors = {ct:'#FF4D00',sundown:'#FF9200',dc:'#00CCFF',dd:'#FFD000',jl:'#0088FF',
    rf:'#CC0000',skar:'#AA44FF',ab:'#FF4D00',fi:'#00FF88',ace:'#00CCFF',
    d4s:'#FFD000',avatar:'#AA44FF',skyhigh:'#00DDFF',orion:'#FF6600',psi:'#00FF88',
    deafbonce:'#CC2200',rs:'#00CCFF',ia:'#FF3333',sq:'#FFD000',massive:'#FF4D00',b2:'#FF8800',gz:'#44FF88'};
  var col = colors[bk] || '#FF4D00';
  return '<div style="display:inline-flex;align-items:center;justify-content:center;' +
    'width:32px;height:32px;border-radius:8px;background:rgba(255,255,255,.06);' +
    'border:1px solid ' + col + '33;font-family:Russo One,sans-serif;font-size:9px;' +
    'color:' + col + ';font-weight:700;letter-spacing:1px;">' + initials + '</div>';
}
function elecAmpBrand() {
  var bk = document.getElementById("e_amp_brand").value;
  var sel = document.getElementById("e_amp_model");
  sel.innerHTML = '<option value="">— Model —</option>';
  document.getElementById("e_amp_info").style.display = "none";
  if (!bk || typeof AMP_DB === "undefined" || !AMP_DB[bk]) return;
  AMP_DB[bk].forEach(function(a) {
    var opt = document.createElement("option");
    opt.value = a.model;
    opt.textContent = a.model + (a.rms_1ohm ? " · " + a.rms_1ohm + "W @1Ω" : a.rms_2ohm ? " · " + a.rms_2ohm + "W @2Ω" : "");
    sel.appendChild(opt);
  });
}

function elecAmpModel() {
  var bk  = document.getElementById("e_amp_brand").value;
  var mdl = document.getElementById("e_amp_model").value;
  if (!bk || !mdl || typeof AMP_DB === "undefined") return;
  var amp = (AMP_DB[bk]||[]).find(function(a){ return a.model === mdl; });
  if (!amp) return;
  // Push best RMS to e_rms — use load closest to user's current wiring
  var ohms = parseFloat(document.getElementById("e_amp_model").dataset.ohms || "2");
  var rms = amp.rms_1ohm || amp.rms_2ohm || amp.rms_4ohm || 0;
  document.getElementById("e_rms").value = rms;
  // Push class to amp class selector
  var cls = (amp.class||"d").toLowerCase();
  var acBtn = document.getElementById("ac_" + cls);
  if (acBtn) { setAC(cls, acBtn); }
  // Show amp info card
  var info = document.getElementById("e_amp_info");
  if (info) {
    var rows = "";
    if (amp.rms_1ohm) rows += "1Ω: " + amp.rms_1ohm + "W  ";
    if (amp.rms_2ohm) rows += "2Ω: " + amp.rms_2ohm + "W  ";
    if (amp.rms_4ohm) rows += "4Ω: " + amp.rms_4ohm + "W  ";
    if (amp.price)    rows += "· $" + amp.price + "  ";
    if (amp.tier)     rows += "· " + amp.tier.toUpperCase();
    if (amp.strappable) rows += "  · STRAPPABLE";
    info.textContent = rows.trim();
    info.style.display = "block";
  }
  elecRun();
}

function runBlowThru() {
  var w  = parseFloat(document.getElementById("bt_w").value)      || 0;
  var h  = parseFloat(document.getElementById("bt_h").value)      || 0;
  var g  = parseFloat(document.getElementById("bt_gap").value)    || 0;
  var nv = parseFloat(document.getElementById("bt_netvol").value) || 0;
  var resCard  = document.getElementById("bt-results");
  var warnCard = document.getElementById("bt-warn-card");
  if (!resCard) return;
  if (!w || !h) { resCard.style.display="none"; if(warnCard) warnCard.style.display="none"; return; }
  var perimIn = (w + h) * 2;
  var bootIn  = perimIn + 6;
  var bootFt  = +(bootIn / 12).toFixed(2);
  var area    = +(w * h).toFixed(1);
  var dispFt3 = +((w * h * g) / 1728).toFixed(3);
  var flangeW = +Math.max(1.5, Math.min(w,h) * 0.15).toFixed(2);
  var corrVol = nv > 0 ? +(nv + dispFt3).toFixed(3) : null;
  resCard.style.display = "block";
  H("bt-big",
    '<div class="bn"><div class="bv fire">' + bootFt + '</div><div class="bl">BOOT (FT)</div></div>' +
    '<div class="bn"><div class="bv ice">' + dispFt3 + '</div><div class="bl">DISP (FT³)</div></div>' +
    '<div class="bn"><div class="bv gd">' + area + '</div><div class="bl">AREA (IN²)</div></div>'
  );
  var rows = '';
  rows += '<div class="rl"><span class="rk">CUT DIMENSIONS</span><span class="rv fire">' + w + '\" W x ' + h + '\" H</span></div>';
  rows += '<div class="rl"><span class="rk">OPENING AREA</span><span class="rv">' + area + ' sq in</span></div>';
  rows += '<div class="rl"><span class="rk">BOOT LENGTH NEEDED</span><span class="rv fire">' + bootIn.toFixed(1) + '\" (' + bootFt + ' ft)</span></div>';
  rows += '<div class="rl"><span class="rk">BOOT FLANGE WIDTH (min)</span><span class="rv">' + flangeW + '\"</span></div>';
  rows += '<div class="rl"><span class="rk">GAP DEPTH</span><span class="rv">' + g + '\"</span></div>';
  rows += '<div class="rl" style="background:rgba(0,204,255,.05);border-color:rgba(0,204,255,.2);">' +
    '<span class="rk">TUNNEL DISPLACEMENT</span><span class="rv ice">' + dispFt3 + ' ft³ â subtract from gross vol</span></div>';
  if (corrVol !== null) {
    rows += '<div class="rl" style="background:rgba(0,255,136,.05);border-color:rgba(0,255,136,.2);">' +
      '<span class="rk">GROSS BOX VOL NEEDED</span><span class="rv gr">' + corrVol +
      ' ft³ (net ' + nv + ' + tunnel ' + dispFt3 + ')</span></div>';
  }
  H("bt-rows", rows);
  var warns = [];
  if (w > 44) warns.push("Cut width " + w + " is very wide - verify no structural members in path.");
  if (h > 18) warns.push("Cut height " + h + " - check rear window trim and bed floor clearance.");
  if (g < 1.5) warns.push("Gap " + g + " is tight - accordion boot needs 1.5 minimum to seal.");
  if (dispFt3 > 0.5) warns.push("Tunnel eats " + dispFt3 + " ft3 - make sure gross box volume accounts for this.");
  if (w < 10 || h < 6) warns.push("Opening too small - minimum 10 x 6 recommended for airflow.");
  if (warnCard) {
    if (warns.length) {
      warnCard.style.display = "block";
      H("bt-warn-list", warns.map(function(msg) {
        return '<div class="ti" style="color:var(--red);background:rgba(255,51,51,.06);border-color:rgba(255,51,51,.2);margin-bottom:4px;">' + msg + "</div>";
      }).join(""));
    } else {
      warnCard.style.display = "none";
    }
  }
}

function elecRun(){
  const rms=gv('e_rms',1000),g=gs('e_gauge')||'1/0',len=gv('e_len',15),base=gv('e_load',40);
  let alt=Math.max(60,gv('e_alt',130));
  // Dual alt support
  var isDual = document.getElementById("alt_dual") && document.getElementById("alt_dual").classList.contains("on");
  if (isDual) {
    var a1 = Math.max(60, parseFloat((document.getElementById("alt_1_amps")||{value:"130"}).value)||130);
    var a2 = Math.max(0,  parseFloat((document.getElementById("alt_2_amps")||{value:"0"}).value)||0);
    alt = a1 + a2;
  }

  const eff=AC_EFF[ST.ac]||0.85;
  const big3_upgrade=gs('fuse_big3')=='1';
  const r=BF.elec(rms,g,len,alt,base,eff,big3_upgrade);
  const vc=r.vd<0.3?'gr':r.vd<0.5?'gd':'red';
  const ac=r.am>20?'gr':r.am>0?'gd':'red';
  H('elec-big',`
    <div class="bn"><div class="bv fire">${r.draw}A</div><div class="bl">DRAW</div></div>
    <div class="bn"><div class="bv ${vc}">${r.vd}V</div><div class="bl">DROP</div></div>
    <div class="bn"><div class="bv">${r.tv}V</div><div class="bl">AT AMP</div></div>
    <div class="bn"><div class="bv ${ac}">${r.am>0?'+':''}${r.am}A</div><div class="bl">ALT MGN</div></div>`);
  const wc=r.wlp>100?'red':r.wlp>80?'gd':'gr';
  const heatClr=r.heatW>500?'var(--red)':r.heatW>200?'var(--gd)':'var(--mu2)';
  H('elec-rows',`
    <div class="rl" style="background:rgba(255,77,0,0.06);border-color:rgba(255,77,0,0.2);">
      <span class="rk">AMP CLASS</span>
      <span class="rv fire">${ST.ac.toUpperCase()} · ${r.eff}% EFFICIENT</span>
    </div>
    <div class="rl"><span class="rk">CURRENT DRAW</span><span class="rv fire">${r.draw}A</span></div>
    <div class="rl"><span class="rk">AMP HEAT OUTPUT</span><span class="rv" style="color:${heatClr}">${r.heatW}W as heat</span></div>
    <div class="rl"><span class="rk">WIRE · ${WL[g]}</span><span class="rv ${wc}">${r.wlp}% capacity</span></div>
    <div class="rl"><span class="rk">ROUND-TRIP DROP (2×${len}ft)</span><span class="rv ${vc}">${r.vd}V</span></div>
    <div class="rl"><span class="rk">TERMINAL VOLTAGE AT AMP</span><span class="rv">${r.tv}V</span></div>
    <div class="rl"><span class="rk">ACTUAL OUTPUT @ ${r.tv}V</span><span class="rv gd">${r.ap}W</span></div>
    <div class="rl"><span class="rk">RECOMMENDED ANL FUSE</span><span class="rv ice">${r.fuse}A</span></div>
    <div class="rl"><span class="rk">ALT HEADROOM</span><span class="rv ${ac}">${r.am>0?'+':''}${r.am}A</span></div>`);
  const pct=Math.min(100,(r.vd/1.0)*100);
  const bc=r.vd<0.3?'var(--gr)':r.vd<0.5?'var(--gd)':'var(--red)';
  document.getElementById('e-vb').style.cssText=`width:${pct}%;background:${bc}`;
  document.getElementById('e-vbl').textContent=r.vd<0.3?'✅ EXCELLENT':r.vd<0.5?'⚠️ ACCEPTABLE':'🔴 TOO HIGH';
  const wires=['2/0','1/0','2AWG','4AWG','8AWG'];
  H('elec-tbl',wires.map(gg=>{
    const Rwt=BF.cfg.R[gg],mAwt=BF.cfg.maxA[gg],vdwt=+(r.draw*Rwt*len*2).toFixed(3),okwt=r.draw<=mAwt;
    const cwt=!okwt?'var(--red)':vdwt<0.3?'var(--gr)':vdwt<0.5?'var(--gd)':'var(--mu2)';
    return`<div class="rl" style="${gg===g?'border-color:rgba(255,77,0,.4);':''}"><span class="rk">${WL[gg]} · max ${mAwt}A</span><span class="rv" style="color:${cwt}">${vdwt}V ${okwt?'':'\u274C'}</span></div>`;
  }).join(''));
  buildB3(r);
  var _pill=document.getElementById("hpill");
  if(_pill){
    if(r.am>0){
      _pill.textContent="VOLTAGE STABLE";
      _pill.style.cssText="background:rgba(0,255,136,.12);border-color:var(--gr);color:var(--gr);";
    } else if(r.am>-30){
      _pill.textContent="TIA MARGINAL";
      _pill.style.cssText="background:rgba(255,208,0,.1);border-color:var(--gd);color:var(--gd);";
    } else {
      _pill.textContent="UNDERPOWERED";
      _pill.style.cssText="background:rgba(255,51,51,.1);border-color:var(--red);color:var(--red);";
    }
  }
}

function clipRun(){
  const hu    = gv('clip_hu', 4);
  const sens  = gv('clip_sens', 4);
  const gainPct = gv('clip_gain', 50) / 100;
  const proc  = parseFloat(gs('clip_proc') || '1');
  // Actual signal level arriving at amp input
  const signalV = hu * proc;
  // Gain-adjusted input sensitivity threshold
  const threshold = sens * (0.1 + gainPct * 0.9); // gain range: 10% to 100% of sensitivity
  const ratio = signalV / threshold;
  const headroomdB = +(20 * Math.log10(threshold / signalV)).toFixed(1);
  const clipping = ratio > 1;
  const margindB = clipping ? headroomdB : Math.abs(headroomdB);
  const color = clipping ? 'var(--red)' : ratio > 0.85 ? 'var(--gd)' : 'var(--gr)';
  const status = clipping ? 'CLIPPING' : ratio > 0.85 ? 'NEAR CLIP' : 'CLEAN';
  H('clip-result', `
    <div style="background:var(--stone3);border:1px solid ${color.replace('var(','').replace(')','')};border-radius:9px;padding:12px;border-color:${color.replace('--','').replace('var(','rgba(').replace(')',',0.3)')};background:${color.replace('--','').replace('var(','rgba(').replace(')',',0.06)')};">
      <div style="font-family:'Black Ops One',cursive;font-size:18px;color:${color};letter-spacing:2px;margin-bottom:6px;">${status}</div>
      <div class="rl"><span class="rk">SIGNAL IN</span><span class="rv">${signalV.toFixed(2)}V</span></div>
      <div class="rl"><span class="rk">AMP THRESHOLD</span><span class="rv">${threshold.toFixed(2)}V</span></div>
      <div class="rl"><span class="rk">HEADROOM</span><span class="rv" style="color:${color}">${clipping ? '-' : '+'}${Math.abs(headroomdB)} dB</span></div>
      <div style="font-family:'Share Tech Mono',monospace;font-size:9px;color:var(--mu2);margin-top:8px;line-height:1.6;">
        ${clipping
          ? 'Your amp is being driven into clip. Reduce HU volume OR turn amp gain down. Every dB of clip = sustained thermal stress on the voice coil.'
          : ratio > 0.85
          ? 'Close to clipping. Keep HU below 80% or lower amp gain slightly for headroom.'
          : 'Signal chain looks clean. Amp gain is set correctly for this source.'}
      </div>
    </div>`);
}
function buildB3(r){
  const n=r.draw>80,na=r.am<20;
  H('b3list',`
    <div class="b3i"><div class="b3c ${n?'need':'done'}">${n?'!':'✓'}</div><div class="b3t"><div class="b3n">Main Power Wire (Battery → Fuse → Amp)</div><div class="b3s">${n?'UPGRADE: 1/0 OFC from battery':'Size appropriate'}</div></div></div>
    <div class="b3i"><div class="b3c ${n?'need':'done'}">${n?'!':'✓'}</div><div class="b3t"><div class="b3n">Ground Wire (Amp → Body Ground)</div><div class="b3s">${n?'UPGRADE: Match to power wire gauge':'Standard ground acceptable'}</div></div></div>
    <div class="b3i"><div class="b3c ${na?'need':'done'}">${na?'!':'✓'}</div><div class="b3t"><div class="b3n">Alternator → Battery Wire</div><div class="b3s">${na?'HIGH-OUTPUT ALT recommended':'Alt output sufficient'}</div></div></div>`);
}

/* ═══ SPL ═══ */
function splRun(){
  const sens=gv('sp_s',87),wts=gv('sp_w',1000),n=gv('sp_n',1),vel=gv('sp_v',14);
  const cabin=parseFloat(gs('sp_veh'))||7,mode=gs('sp_mode')||'daily';
  if(wts<=0||n<=0)return;
  const r=BF.spl(sens,wts,n,cabin,vel,mode);
  const sc=r.spl>=160?'var(--red)':r.spl>=150?'var(--gd)':'var(--fire)';
  document.getElementById('spl-big').textContent=r.spl+' dB';
  document.getElementById('spl-big').style.color=sc;
  const tiers=[{lb:'STREET',lo:130,hi:140,c:'#00CC66'},{lb:'COMP',lo:140,hi:150,c:'#FF9200'},{lb:'PRO SPL',lo:150,hi:160,c:'#FF6600'},{lb:'EXTREME',lo:160,hi:180,c:'#FF3333'}];
  H('spl-tiers',tiers.map(t=>{
    const isOn=r.spl>=t.lo&&r.spl<t.hi,abv=r.spl>=t.hi;
    const pct=abv?100:isOn?Math.min(100,((r.spl-t.lo)/(t.hi-t.lo))*100):0;
    return`<div class="stier ${isOn?'on':''}"><span class="stlb" style="color:${isOn||abv?t.c:'var(--mu)'}">${t.lb}</span><span class="strg">${t.lo}–${t.hi}</span><div class="sbw"><div class="sbar" style="width:${pct}%;background:${t.c}"></div></div>${isOn?`<span style="font-family:'Share Tech Mono',monospace;font-size:8px;color:${t.c}">◀</span>`:''}</div>`;
  }).join(''));
  H('spl-rows',`
    <div class="rl"><span class="rk">SENSITIVITY</span><span class="rv">${sens} dB/W/m</span></div>
    <div class="rl"><span class="rk">POWER GAIN</span><span class="rv fire">+${r.pg} dB</span></div>
    <div class="rl"><span class="rk">MULTI-SUB GAIN</span><span class="rv gr">+${r.sg} dB</span></div>
    <div class="rl"><span class="rk">CABIN GAIN</span><span class="rv gd">+${cabin} dB</span></div>
    ${r.cl>0?`<div class="rl"><span class="rk">PORT COMPRESSION LOSS</span><span class="rv red">−${r.cl} dB</span></div>`:''}
    ${r.mb>0?`<div class="rl"><span class="rk">SPL MODE BONUS</span><span class="rv" style="color:var(--pu)">+${r.mb} dB</span></div>`:''}
    <div class="rl"><span class="rk">PREDICTED PEAK SPL</span><span class="rv" style="color:${sc};font-size:15px">${r.spl} dB</span></div>`);
}

/* ═══ CUTS ═══ */
function cutsRun(){
  setTimeout(function(){ runBraceAdvisor(); cutsRunExtended(); }, 80);
  const dims={w:gv('cs_w',32),h:gv('cs_h',15),d:gv('cs_d',18)};
  const mk=gs('cs_mat')||'mdf75',ns=parseInt(gs('cs_ns'))||1,db=parseInt(gs('cs_db'))||0;
  const mat=MATS[mk];
  const r=BF.cuts(dims,mat.t,db===1,ns);
  H('cut-list',r.panels.map((p,i)=>`
    <div class="ci" style="${p.green?'border-color:rgba(0,255,136,.25)':''}">
      <div class="cnum" style="${p.green?'background:rgba(0,255,136,.1);border-color:rgba(0,255,136,.3);color:var(--gr)':''}">${i+1}</div>
      <div class="cinfo"><div class="cnm" style="${p.green?'color:var(--gr)':''}">${p.name}${p.note?` <span style="font-size:9px;color:var(--mu)">— ${p.note}</span>`:''}</div>
      <div class="cdm" style="${p.green?'color:var(--gr)':''}">${p.w.toFixed(2)}" × ${p.d.toFixed(2)}"</div></div>
      <div class="cqty">QTY ${p.qty}</div>
    </div>`).join(''));
  H('mat-note',`
    🪵 Material: <strong style="color:var(--wh)">${mat.label}</strong><br>
    📐 Total Panel Area: <strong style="color:var(--ice)">${r.totalA.toLocaleString()} sq in</strong><br>
    📦 Sheets Needed: <strong style="color:var(--gd)">${r.sheets} × 4'×8'</strong> (22% waste included)<br>
    💰 Est. Material Cost: <strong style="color:var(--fire)">~$${r.sheets*mat.cost}</strong><br>
    🔩 Wood glue + 1.5" screws every 6" · Pre-drill · Silicone all interior seams`);
}

/* ═══ FULL AUDIT ═══ */
function runAudit(){
  const vdb=VDB[gs('t_veh')||'standard']||VDB.standard;
  const inp={
    rms:gv('t_rms',1000),qty:gv('t_qty',2),veh:gs('t_veh')||'standard',
    alt:gv('t_alt',130),gauge:gs('e_gauge')||'1/0',len:gv('e_len',15),
    base:gv('e_load',40),wood:gv('b_wood',0.75),brace:gv('b_brace',0.03),
    cm:ST.cm,sm:ST.sm,sens:gv('t_sens',87),
    cabin:parseFloat(gs('sp_veh'))||vdb.cabinGain||7,
    portType:gs('b_pt')||'slot',
    dims:{w:gv('b_w',32),h:gv('b_h',15),d:gv('b_d',18)},
    port:{w:gv('b_pw',3),len:gv('b_pl',24)},
    sub:{disp:gv('b_disp',0.14),ohms:gv('t_ohms',2),isDVC:gs('t_dvc')==='dvc',rms:gv('t_rms',1000)},
  };
  const res=BF.audit(inp);
  ST.lastAudit={inp,res,ts:new Date()};
  const sc=res.score;
  const pill=document.getElementById('hpill');
  pill.textContent=sc+'/100';
  pill.className=sc>=80?'ok':sc>=55?'warn':'bad';
  buildAuditReport(res,sc);
  sw('audit');
}

function buildAuditReport(res,sc){
  show('audit-empty',false);show('audit-content',true);
  // FORGE CERTIFICATION [v22]
  let cert='';
  if(sc>=85)cert=`<div class="cert"><div class="cert-icon">🔥</div><div class="cert-title certified">FORGE CERTIFIED</div><div class="cert-sub">SCORE ${sc}/100 · ALL CRITICAL CHECKS PASSED</div></div>`;
  else if(sc>=60)cert=`<div class="cert"><div class="cert-icon">⚠️</div><div class="cert-title warn">NEEDS WORK</div><div class="cert-sub">SCORE ${sc}/100 · FIX FLAGGED ITEMS</div></div>`;
  else cert=`<div class="cert"><div class="cert-icon">🔴</div><div class="cert-title fail">NOT CERTIFIED</div><div class="cert-sub">SCORE ${sc}/100 · CRITICAL ISSUES</div></div>`;
  H('forge-cert',cert);
  const snum=document.getElementById('audit-sc');
  snum.textContent=sc;snum.style.color=sc>=80?'var(--gr)':sc>=55?'var(--gd)':'var(--red)';
  const hb=document.getElementById('audit-hb');
  hb.style.width=sc+'%';hb.style.background=sc>=80?'var(--gr)':sc>=55?'var(--gd)':'var(--red)';
  document.getElementById('audit-ts').textContent=`GENERATED: ${new Date().toLocaleString()} · v24.0 · ID: ${res.buildID}`;

  const b=res.b,w=res.w,e=res.e,s=res.s;
  H('audit-sum',`
    <div style="font-family:'Share Tech Mono',monospace;font-size:8px;letter-spacing:2px;color:var(--fire);margin-bottom:8px;">MOD 1 — ENCLOSURE</div>
    ${b?`<div class="rl"><span class="rk">NET VOLUME</span><span class="rv gr">${b.net} ft³</span></div>
    <div class="rl"><span class="rk">TUNING</span><span class="rv gd">${b.fb} Hz</span></div>
    <div class="rl"><span class="rk">PORT VELOCITY</span><span class="rv ${b.vel<=17?'gr':b.vel<=25?'gd':'red'}">${b.vel} m/s</span></div>`:'<div class="ti bad">Invalid enclosure</div>'}
    <div style="font-family:'Share Tech Mono',monospace;font-size:8px;letter-spacing:2px;color:var(--ice);margin:10px 0 8px;">MOD 2 — WIRING</div>
    <div class="rl"><span class="rk">FINAL LOAD</span><span class="rv ice">${w.fl}Ω</span></div>
    <div class="rl"><span class="rk">STABILITY</span><span class="rv ${w.rating==='good'?'gr':w.rating==='unstable'?'red':'gd'}">${w.rating.toUpperCase()}</span></div>
    <div style="font-family:'Share Tech Mono',monospace;font-size:8px;letter-spacing:2px;color:var(--gd);margin:10px 0 8px;">MOD 3 — ELECTRICAL</div>
    <div class="rl"><span class="rk">CURRENT DRAW</span><span class="rv fire">${e.draw}A</span></div>
    <div class="rl"><span class="rk">VOLTAGE DROP</span><span class="rv ${e.vd<0.3?'gr':e.vd<0.5?'gd':'red'}">${e.vd}V</span></div>
    <div class="rl"><span class="rk">TERMINAL VOLTAGE</span><span class="rv">${e.tv}V</span></div>
    <div class="rl"><span class="rk">ANL FUSE</span><span class="rv ice">${e.fuse}A</span></div>
    <div class="rl"><span class="rk">ALT MARGIN</span><span class="rv ${e.am>20?'gr':e.am>0?'gd':'red'}">${e.am>0?'+':''}${e.am}A</span></div>
    <div style="font-family:'Share Tech Mono',monospace;font-size:8px;letter-spacing:2px;color:var(--pu);margin:10px 0 8px;">SPL PREDICTION</div>
    <div class="rl"><span class="rk">PREDICTED PEAK</span><span class="rv" style="color:var(--pu)">${s.spl} dB</span></div>
    ${s.cl>0?`<div class="rl"><span class="rk">PORT COMP LOSS</span><span class="rv red">−${s.cl} dB</span></div>`:''}`);

  H('audit-find',res.rpts.map(r=>`<div class="ti ${r.cls}">${r.msg}</div>`).join(''));
  const checks=[
    {done:!!b&&b.vel<=25,  txt:'Port velocity ≤25 m/s'},
    {done:!!b&&b.net>0.5,  txt:'Adequate net enclosure volume'},
    {done:w.fl>=1,          txt:'Amp-stable impedance (≥1Ω)'},
    {done:e.vd<=0.5,        txt:'Voltage drop ≤0.5V'},
    {done:e.wlp<=80,        txt:'Wire gauge not near capacity'},
    {done:e.am>=0,          txt:'Alternator output sufficient'},
    {done:e.am>=20,         txt:'20A+ alternator headroom'},
    {done:e.vd<=0.3,        txt:'Voltage drop excellent (<0.3V)'},
    {done:!!b&&b.vel<=17,   txt:'Port velocity excellent (<17 m/s)'},
  ];
  H('audit-chk',checks.map(c=>`
    <div class="b3i"><div class="b3c ${c.done?'done':'need'}">${c.done?'✓':'✗'}</div>
    <div class="b3t"><div class="b3n" style="color:${c.done?'var(--gr)':'var(--red)'}">${c.txt}</div></div></div>`).join(''));
  document.getElementById('tab-audit').style.borderBottomColor=sc>=80?'var(--gr)':sc>=55?'var(--gd)':'var(--red)';
}

/* ═══ SUB DATABASE — v24.0 ═══ */
function dbLoadModels(){
  const brand=DB_STATE.brand;
  const models=SUB_DB[brand]||[];
  sv('db_model','');
  document.getElementById('db_model').innerHTML=
    '<option value="">— Select Model —</option>'+
    models.map((m,i)=>`<option value="${i}">${m.model} · ${m.sz}" · ${m.rms}W</option>`).join('');
  show('db-spec-card',false);
  dbRenderAll();
}

function dbShowSpec(){
  const brand=DB_STATE.brand;
  const idx=DB_STATE.modelIdx;
  const subs=SUB_DB[brand];
  if(!subs||idx<0||idx>=subs.length){show('db-spec-card',false);return;}
  const s=subs[idx];
  if(!s){show('db-spec-card',false);return;}
  H('db-big',`
    <div class="bn"><div class="bv fire">${s.rms}</div><div class="bl">RMS WATTS</div></div>
    <div class="bn"><div class="bv gd">${s.sens}</div><div class="bl">SENS dB</div></div>
    <div class="bn"><div class="bv ice">${s.fs}</div><div class="bl">Fs Hz</div></div>`);
  H('db-rows',`
    <div class="rl"><span class="rk">MODEL</span><span class="rv fire">${s.model}</span></div>
    <div class="rl"><span class="rk">SIZE</span><span class="rv">${s.sz}"</span></div>
    <div class="rl"><span class="rk">RMS POWER</span><span class="rv fire">${s.rms}W</span></div>
    <div class="rl"><span class="rk">SENSITIVITY</span><span class="rv gd">${s.sens} dB/W/m</span></div>
    <div class="rl"><span class="rk">Fs (FREE AIR RESONANCE)</span><span class="rv ice">${s.fs} Hz</span></div>
    ${s.qts ? '<div class="rl"><span class="rk">Qts (TOTAL Q)</span><span class="rv ice">'+s.qts+'</span></div>' : ''}
    ${s.vas ? '<div class="rl"><span class="rk">Vas (EQUIV. VOLUME)</span><span class="rv">'+s.vas+' L</span></div>' : ''}
    ${s.xmax||s.xm ? '<div class="rl"><span class="rk">Xmax (EXCURSION)</span><span class="rv pu">'+(s.xmax||s.xm)+' mm</span></div>' : ''}
    <div class="rl"><span class="rk">DISPLACEMENT</span><span class="rv">${s.disp} ft³</span></div>
    <div class="rl"><span class="rk">IMPEDANCE</span><span class="rv">${s.ohms}Ω · ${s.dvc?'DVC':'SVC'}</span></div>
    <div class="rl" style="background:rgba(0,255,136,0.05);border-color:rgba(0,255,136,0.15);">
      <span class="rk">RECOMMENDED BOX</span>
      <span class="rv gr">${s.rec_vol} ft³ @ ${s.rec_tune} Hz</span>
    </div>`);
  show('db-spec-card',true);
}

function showForgeToast(msg){
  const t = document.getElementById('forge-toast');
  if(!t) return;
  t.textContent = msg || '⚡ LOADED TO FORGE';
  t.style.opacity = '1';
  setTimeout(() => t.style.opacity = '0', 2000);
}

function dbLoadToForge(){
  const brand=DB_STATE.brand;
  const idx=DB_STATE.modelIdx;
  const subs=SUB_DB[brand];
  if(!subs||idx<0||idx>=subs.length)return;
  const s=subs[idx];
  if(!s)return;
  window._lastSubSpec = Object.assign({}, s, {xmax: s.xmax||s.xm||0});
  sv('t_rms',s.rms);
  sv('t_sz',s.sz);
  sv('t_ohms',s.ohms||2);
  sv('t_dvc',s.dvc?'dvc':'svc');
  sv('t_sens',s.sens);
  sv('b_disp',s.disp);
  if(s.rec_vol  != null) sv('af_vol', s.rec_vol);
  if(s.rec_tune != null) sv('af_tune',s.rec_tune);
  sv('sp_s',s.sens);
  sv('sp_w',s.rms);
  if(s.fs) { sv('bp4_fs',s.fs);  sv('bp6_fs',s.fs);  }
  if(s.qts){ sv('bp4_qts',s.qts);sv('bp6_qts',s.qts);}
  if(s.vas){ sv('bp4_vas',s.vas);sv('bp6_vas',s.vas);}
  lsync();
  sw('forge');
  setTimeout(function(){ runBoxMaster(); showForgeToast('⚡ '+s.model+' LOADED'); }, 80);
}

function dbShowTS(){
  const brand=DB_STATE.brand,idx=DB_STATE.modelIdx;
  const subs=SUB_DB[brand];
  if(!subs||idx<0||idx>=subs.length)return;
  const s=subs[idx];
  if(!s.qts||!s.vas)return;
  const sealedSQ  = TS.sealedVol(s.qts, s.vas, 0.707);
  const sealedExt = TS.sealedVol(s.qts, s.vas, 1.0);
  const portedOpt = TS.portedVol(s.qts, s.vas);
  const portedFb  = TS.portedFb(s.fs, s.qts);
  const f3sealed  = sealedSQ ? TS.sealedF3(s.fs, s.qts, s.vas, sealedSQ) : null;
  const tsEl2 = document.getElementById('db-ts-content');
  const tsEl = document.getElementById('db-ts-results');
  if (tsEl2) tsEl2.innerHTML = '';
  if(!tsEl) return;
  tsEl.style.display='block';
  tsEl.innerHTML=`
    <div style="font-family:'Share Tech Mono',monospace;font-size:8px;letter-spacing:2px;color:var(--gr);margin-bottom:8px;">TS-DERIVED OPTIMAL BOX</div>
    <div class="rl" style="background:rgba(0,255,136,.05);border-color:rgba(0,255,136,.15);">
      <span class="rk">SEALED — FLAT (Qtc 0.707)</span>
      <span class="rv gr">${sealedSQ || 'N/A'} ft³</span>
    </div>
    <div class="rl" style="background:rgba(0,255,136,.03);">
      <span class="rk">SEALED — EXTENDED (Qtc 1.0)</span>
      <span class="rv gr">${sealedExt || 'N/A'} ft³</span>
    </div>
    ${f3sealed ? '<div class="rl"><span class="rk">-3dB POINT (sealed flat)</span><span class="rv ice">'+f3sealed+' Hz</span></div>' : ''}
    <div class="rl" style="background:rgba(255,77,0,.05);border-color:rgba(255,77,0,.15);">
      <span class="rk">PORTED — OPTIMAL</span>
      <span class="rv fire">${portedOpt || 'N/A'} ft³</span>
    </div>
    <div class="rl" style="background:rgba(255,77,0,.03);">
      <span class="rk">PORTED — OPTIMAL Fb</span>
      <span class="rv fire">${portedFb || 'N/A'} Hz</span>
    </div>
    <div class="rl">
      <span class="rk">MFR RECOMMENDED</span>
      <span class="rv gd">${s.rec_vol} ft³ @ ${s.rec_tune} Hz</span>
    </div>
    <div style="font-family:'Share Tech Mono',monospace;font-size:8px;color:var(--mu);margin-top:6px;line-height:1.6;">
      TS math uses Qts=${s.qts}, Vas=${s.vas}L, Fs=${s.fs}Hz
    </div>`;
}
function dbRenderAll(){
  const brand=DB_STATE.brand;
  if(!brand){
    H('db-all',Object.keys(SUB_DB).map(k=>`
      <div class="rl"><span class="rk">${BRAND_NAMES[k]||k}</span>
      <span class="rv" style="color:var(--mu2)">${SUB_DB[k].length} models</span></div>`).join(''));
    return;
  }
  const subs=SUB_DB[brand]||[];
  H('db-all',subs.map((s,i)=>`
    <div class="rl" style="cursor:pointer;" onclick="sv('db_model','${i}');dbShowSpec()">
      <span class="rk">${s.sz}" · ${s.model}</span>
      <span class="rv fire">${s.rms}W · ${s.sens}dB</span>
    </div>`).join(''));
}

/* ═══ PDF EXPORT [v22] ═══ */
function exportPDF(){
  if(!window.jspdf){alert('jsPDF not loaded — check your internet connection.');return;}
  const{jsPDF}=window.jspdf;
  const doc=new jsPDF({unit:'mm',format:'letter'});
  const la=ST.lastAudit;
  doc.setFillColor(8,8,8);doc.rect(0,0,216,279,'F');
  doc.setTextColor(255,77,0);doc.setFont('helvetica','bold');doc.setFontSize(22);
  doc.text('BASSFORGE BUILD BLUEPRINT',20,22);
  doc.setFontSize(9);doc.setTextColor(100,100,100);
  doc.text('v24.0 · Low End Labs · '+new Date().toLocaleDateString(),20,30);
  doc.setDrawColor(255,77,0);doc.setLineWidth(0.5);doc.line(20,34,196,34);
  let y=42;
  const sec=(title,color)=>{
    doc.setTextColor(...color);doc.setFontSize(10);doc.setFont('helvetica','bold');
    doc.text('// '+title,20,y);y+=7;
    doc.setDrawColor(...color);doc.setLineWidth(0.2);doc.line(20,y,196,y);y+=5;
  };
  const row=(k,v,color)=>{
    doc.setTextColor(150,150,150);doc.setFont('helvetica','normal');doc.setFontSize(9);
    doc.text(k,20,y);
    doc.setTextColor(...(color||[245,245,245]));doc.setFont('helvetica','bold');
    doc.text(String(v),120,y);y+=6;
  };
  if(la){
    const{b,w,e,s}=la.res,sc=la.res.score;
    sec('SYSTEM OVERVIEW',[255,77,0]);
    row('Health Score',sc+'/100',sc>=80?[0,255,136]:sc>=55?[255,208,0]:[255,51,51]);
    row('Certification',sc>=85?'FORGE CERTIFIED':sc>=60?'NEEDS WORK':'NOT CERTIFIED');
    row('Vehicle',VDB[gs('t_veh')]?.name||'Standard');y+=4;
    if(b){
      sec('MODULE 1 — ENCLOSURE',[255,77,0]);
      row('Gross Volume',b.gross+' ft³');row('Net Volume',b.net+' ft³',[0,255,136]);
      row('Tuning Frequency',b.fb+' Hz',[255,208,0]);
      row('Port Velocity',b.vel+' m/s',b.vel<=17?[0,255,136]:b.vel<=25?[255,208,0]:[255,51,51]);
      row('Internal W×H×D',b.iW+'" × '+b.iH+'" × '+b.iD+'"');y+=4;
    }
    sec('MODULE 2 — WIRING',[0,204,255]);
    row('Final Amp Load',w.fl+'Ω',[0,204,255]);row('Stability',w.rating.toUpperCase());y+=4;
    sec('MODULE 3 — ELECTRICAL',[255,208,0]);
    row('Current Draw',e.draw+'A',[255,77,0]);
    row('Voltage Drop (Round Trip)',e.vd+'V',e.vd<0.3?[0,255,136]:e.vd<0.5?[255,208,0]:[255,51,51]);
    row('Terminal Voltage at Amp',e.tv+'V');row('ANL Fuse Recommendation',e.fuse+'A',[0,204,255]);
    row('Alternator Headroom',(e.am>0?'+':'')+e.am+'A',e.am>20?[0,255,136]:e.am>0?[255,208,0]:[255,51,51]);y+=4;
    sec('SPL PREDICTION',[187,136,255]);
    row('Predicted Peak SPL',s.spl+' dB',[187,136,255]);
    if(s.cl>0)row('Port Compression Penalty','−'+s.cl+' dB',[255,51,51]);y+=4;
    la.res.rpts.forEach(r=>{
      const c=r.cls==='ok'?[0,200,100]:r.cls==='warn'?[255,208,0]:r.cls==='bad'?[255,51,51]:[0,204,255];
      doc.setTextColor(...c);doc.setFont('helvetica','normal');doc.setFontSize(8);
      const lines=doc.splitTextToSize(r.msg,170);
      doc.text(lines,20,y);y+=lines.length*5+2;
      if(y>255){doc.addPage();doc.setFillColor(8,8,8);doc.rect(0,0,216,279,'F');y=20;}
    });y+=4;
  }
  // Cut sheet
  const csD={w:gv('cs_w',32),h:gv('cs_h',15),d:gv('cs_d',18)};
  const mk=gs('cs_mat')||'mdf75',mat=MATS[mk];
  const cs=BF.cuts(csD,mat.t,false,gv('cs_ns',1)||1);
  if(y>220){doc.addPage();doc.setFillColor(8,8,8);doc.rect(0,0,216,279,'F');y=20;}
  sec('CUT SHEET — '+mat.label,[0,255,136]);
  cs.panels.forEach(p=>row(p.name+' (QTY '+p.qty+')',p.w.toFixed(2)+'" × '+p.d.toFixed(2)+'"'));
  row('Total Panel Area',cs.totalA.toLocaleString()+' sq in');
  row('Sheets Needed',cs.sheets+' × 4\'×8\'');row('Est. Material Cost','~$'+cs.sheets*mat.cost);
  doc.setTextColor(60,60,60);doc.setFontSize(7);doc.setFont('helvetica','normal');
  doc.text('BassForge v5.0 · Low End Labs · All calculations are estimates. Verify with a licensed installer.',20,272);
  doc.save('bassforge_'+new Date().toISOString().slice(0,10)+'.pdf');
}


/* === TRUNK SPEC DB === */
var TK_DB=[];
try{
  var stored=JSON.parse(localStorage.getItem('bf_trunk_db')||'[]');
  // Merge: keep preloaded vehicles + any user-added ones (id > 1700001000)
  var userAdded=stored.filter(function(e){return e.id>1700001100;});
  TK_DB=TK_DB_PRELOAD.concat(userAdded);
}catch(e){TK_DB=TK_DB_PRELOAD.slice();}
function tkUpd(){
  const el = document.getElementById('tk-count');
  if(el) el.textContent = TK_DB.length;
  // Show VDB vehicle count in forge tab
  const vdbEl = document.getElementById('vdb-count');
  if(vdbEl) vdbEl.textContent = Object.keys(VDB).length;
}
function tksw(id){
  ['add','db','exp'].forEach(function(t){
    document.getElementById('tkp-'+t).style.display=t===id?'block':'none';
    var b=document.getElementById('tst-'+t);
    if(b){b.style.background=t===id?'var(--fire)':'var(--stone4)';b.style.color=t===id?'#fff':'var(--mu)';b.style.border=t===id?'none':'1px solid var(--stone5)';}
  });
  if(id==='db')tkRenderDB();
  if(id==='exp')tkRenderExp();
}
function tkGv(id){return parseFloat(document.getElementById(id).value)||0;}
function tkGs(id){return(document.getElementById(id).value||'').trim();}
function tkSave(){
  var make=tkGs('tk_make'),model=tkGs('tk_model');
  if(!make||!model){alert('Enter Make and Model.');return;}
  var e={id:Date.now(),
    v:{year:tkGs('tk_year'),make:make,model:model,trim:tkGs('tk_trim')},
    opening:{w:tkGv('tk_ow'),h:tkGv('tk_oh'),d:tkGv('tk_od')},
    interior:{w:tkGv('tk_iw'),h:tkGv('tk_ih'),d:tkGv('tk_id')},
    wells:{floorW:tkGv('tk_ww'),protrusion:tkGv('tk_wp'),height:tkGv('tk_wh')},
    floor:tkGs('tk_floor'),fold:tkGs('tk_fold'),placement:tkGs('tk_place'),
    notes:tkGs('tk_notes'),by:tkGs('tk_by')||'Anonymous',verified:tkGs('tk_ver'),
    date:new Date().toLocaleDateString()};
  TK_DB.push(e);
  try{localStorage.setItem('bf_trunk_db',JSON.stringify(TK_DB));}catch(er){}
  tkUpd();
  alert('Saved: '+(e.v.year?e.v.year+' ':'')+make+' '+model);
  tkClear();tksw('db');
}
function tkClear(){
  ['tk_year','tk_make','tk_model','tk_trim','tk_ow','tk_oh','tk_od',
   'tk_iw','tk_ih','tk_id','tk_ww','tk_wp','tk_wh','tk_notes','tk_by']
  .forEach(function(id){var el=document.getElementById(id);if(el)el.value='';});
  tkDraw(0,0,0,0,0,0);
}
function tkDel(id){
  if(!confirm('Delete this vehicle?'))return;
  TK_DB=TK_DB.filter(function(e){return e.id!==id;});
  try{localStorage.setItem('bf_trunk_db',JSON.stringify(TK_DB));}catch(er){}
  tkUpd();tkRenderDB();
}
function loadTrunkToForge(id) {
  var entry = TK_DB.find(function(e){ return e.id === id; });
  if (!entry) return;
  window._lastTrunkEntry = entry;
  var iW = (entry.interior && entry.interior.w) || 0;
  var iH = (entry.interior && entry.interior.h) || 0;
  var iD = (entry.interior && entry.interior.d) || 0;
  if (iW) { sv("b_w", iW); sv("cs_w", iW); sv("af_vol", ((iW-1.5)*(iH-1.5)*(iD-1.5)/1728*0.85).toFixed(2)); }
  if (iH) { sv("b_h", iH); sv("cs_h", iH); }
  if (iD) { sv("b_d", iD); sv("cs_d", iD); }
  var vName = (entry.v.year?entry.v.year+" ":"")+entry.v.make+" "+entry.v.model;
  sw("forge");
  setTimeout(function(){ runBoxMaster(); showForgeToast("⚡ "+vName+" LOADED"); }, 80);
}

function tkRenderDB(){
  var el=document.getElementById('tk-list'),hdr=document.getElementById('tk-db-hdr');
  if(!TK_DB.length){el.innerHTML='<div style="text-align:center;padding:40px 20px;color:var(--mu);font-family:Share Tech Mono,monospace;font-size:10px;">NO VEHICLES YET</div>';hdr.textContent='NO ENTRIES YET';return;}
  var q=(document.getElementById('tk-search')||{value:''}).value.toLowerCase().trim();
  var filtered=TK_DB.filter(function(e){
    if(!q)return true;
    var str=(e.v.year+' '+e.v.make+' '+e.v.model+' '+e.v.trim+' '+e.placement).toLowerCase();
    return str.indexOf(q)>-1;
  });
  filtered.sort(function(a,b){
    var ma=a.v.make+a.v.model, mb=b.v.make+b.v.model;
    return ma.localeCompare(mb);
  });
  hdr.textContent=filtered.length+' of '+TK_DB.length+' VEHICLE'+(TK_DB.length>1?'S':'')+' SHOWN';
  el.innerHTML=filtered.map(function(e){
    var veh=(e.v.year?e.v.year+' ':'')+e.v.make+' '+e.v.model+(e.v.trim?' '+e.v.trim:'');
    var iw=e.interior.w,ih=e.interior.h,id2=e.interior.d;
    var fits=iw>=40&&ih>=13&&id2>=18;
    var fitLbl=(iw>0&&ih>0&&id2>0)?(fits?'FITS 12"':'TIGHT'):'INCOMPLETE';
    var fitClr=fits?'var(--gr)':'var(--gd)';
    var vLbl=e.verified==='built'?'VERIFIED BUILD':e.verified==='measured'?'MEASURED':'ESTIMATED';
    return '<div class="card" style="margin-bottom:10px;">'+
      '<div style="font-family:Russo One,sans-serif;font-size:14px;margin-bottom:8px;">'+veh+'</div>'+
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px;">'+
      '<div style="background:var(--stone3);border-radius:7px;padding:8px;text-align:center;"><div style="font-family:Share Tech Mono,monospace;font-size:14px;color:var(--fire);">'+(iw||'--')+'"</div><div style="font-family:Share Tech Mono,monospace;font-size:7px;color:var(--mu);">INT WIDTH</div></div>'+
      '<div style="background:var(--stone3);border-radius:7px;padding:8px;text-align:center;"><div style="font-family:Share Tech Mono,monospace;font-size:14px;color:var(--fire);">'+(ih||'--')+'"</div><div style="font-family:Share Tech Mono,monospace;font-size:7px;color:var(--mu);">INT HEIGHT</div></div>'+
      '<div style="background:var(--stone3);border-radius:7px;padding:8px;text-align:center;"><div style="font-family:Share Tech Mono,monospace;font-size:14px;color:var(--fire);">'+(id2||'--')+'"</div><div style="font-family:Share Tech Mono,monospace;font-size:7px;color:var(--mu);">INT DEPTH</div></div>'+
      '</div>'+
      '<div style="font-family:Share Tech Mono,monospace;font-size:8px;color:var(--mu2);background:var(--stone3);border-radius:6px;padding:7px;margin-bottom:8px;">OPENING: '+(e.opening.w||'--')+'W x '+(e.opening.h||'--')+'H in  |  FLOOR: '+(e.wells.floorW||'--')+'" between wells</div>'+
      (e.notes?'<div style="font-size:10px;color:var(--mu2);margin-bottom:8px;">NOTES: '+e.notes+'</div>':'')+
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">'+
      '<span style="font-family:Share Tech Mono,monospace;font-size:8px;padding:3px 8px;border-radius:4px;border:1px solid '+fitClr+';color:'+fitClr+';">'+fitLbl+'</span>'+
      '<span style="font-family:Share Tech Mono,monospace;font-size:8px;padding:3px 8px;border-radius:4px;background:rgba(0,204,255,.08);border:1px solid rgba(0,204,255,.2);color:var(--ice);">'+vLbl+'</span>'+
      '<span style="font-family:Share Tech Mono,monospace;font-size:8px;padding:3px 8px;border-radius:4px;background:rgba(255,77,0,.08);border:1px solid rgba(255,77,0,.2);color:var(--fire);">'+e.placement.replace('_',' ').toUpperCase()+'</span>'+
      '</div>'+
      '<button onclick="tkDel('+e.id+')" style="background:rgba(255,51,51,.1);border:1px solid rgba(255,51,51,.2);color:var(--red);font-family:Share Tech Mono,monospace;font-size:8px;padding:5px 12px;border-radius:5px;cursor:pointer;">DELETE</button>'+
      '<button onclick="loadTrunkToForge('+e.id+')" style="background:rgba(0,255,136,.12);border:1px solid rgba(0,255,136,.3);color:var(--gr);font-family:Russo One,sans-serif;font-size:9px;padding:6px 14px;border-radius:8px;cursor:pointer;margin-left:6px;letter-spacing:1px;">&#x26A1; FORGE IT</button>'+
      '<span style="font-family:Share Tech Mono,monospace;font-size:8px;color:var(--mu);margin-left:8px;">'+e.by+' - '+e.date+'</span>'+
    '</div>';
  }).join('');
}
function tkRenderExp(){
  document.getElementById('tk-json').textContent=TK_DB.length?JSON.stringify(TK_DB,null,2):'No data yet.';
  if(!TK_DB.length){document.getElementById('tk-csv').textContent='No data yet.';return;}
  var hdr='year,make,model,trim,open_w,open_h,open_d,int_w,int_h,int_d,floor_w,well_protrusion,well_h,floor_type,fold_seat,placement,notes,by,verified,date';
  var rows=TK_DB.map(function(e){return[e.v.year,e.v.make,e.v.model,e.v.trim,e.opening.w,e.opening.h,e.opening.d,e.interior.w,e.interior.h,e.interior.d,e.wells.floorW,e.wells.protrusion,e.wells.height,e.floor,e.fold,e.placement,'"'+e.notes+'"',e.by,e.verified,e.date].join(',');});
  document.getElementById('tk-csv').textContent=[hdr].concat(rows).join('\n');
}
function tkCopyJSON(){var t=document.getElementById('tk-json').textContent;if(t==='No data yet.'){alert('No data yet.');return;}navigator.clipboard.writeText(t).then(function(){alert('JSON copied!');}).catch(function(){prompt('Copy:',t);});}
function tkCopyCSV(){var t=document.getElementById('tk-csv').textContent;if(t==='No data yet.'){alert('No data yet.');return;}navigator.clipboard.writeText(t).then(function(){alert('CSV copied!');}).catch(function(){prompt('Copy:',t);});}
function tkDiag(){tkDraw(tkGv('tk_ow'),tkGv('tk_oh'),tkGv('tk_iw'),tkGv('tk_ih'),tkGv('tk_id'),tkGv('tk_wp'));}
function tkDraw(ow,oh,iw,ih,id2,wwP){
  var cv=document.getElementById('tk-diag');if(!cv)return;
  var cw=cv.offsetWidth||300;cv.width=cw;
  var ctx=cv.getContext('2d');ctx.clearRect(0,0,cw,130);
  var pad=22,bw=cw-pad*2,bh=88,ox=pad,oy=16;
  ctx.fillStyle='rgba(255,77,0,.04)';ctx.strokeStyle='rgba(255,77,0,.25)';ctx.lineWidth=1.5;
  if(ctx.roundRect)ctx.roundRect(ox,oy,bw,bh,5);else ctx.rect(ox,oy,bw,bh);
  ctx.fill();ctx.stroke();
  if(ow>0&&iw>0){
    var ow2=(ow/iw)*bw,ox2=ox+(bw-ow2)/2,oh2=oh>0&&ih>0?(oh/ih)*bh*0.5:bh*0.35;
    ctx.fillStyle='rgba(0,255,136,.07)';ctx.strokeStyle='rgba(0,255,136,.35)';ctx.lineWidth=1;ctx.setLineDash([3,3]);
    ctx.beginPath();ctx.rect(ox2,oy,ow2,oh2);ctx.fill();ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle='#00FF88';ctx.font='7px monospace';ctx.textAlign='center';
    ctx.fillText('OPENING '+(ow?ow+'"':''),ox2+ow2/2,oy-5);
  }
  if(wwP>0&&iw>0){
    var wp=(wwP/iw)*bw;
    ctx.fillStyle='rgba(0,204,255,.1)';ctx.strokeStyle='rgba(0,204,255,.25)';ctx.lineWidth=1;ctx.setLineDash([]);
    ctx.fillRect(ox,oy+bh*0.4,wp,bh*0.6);ctx.strokeRect(ox,oy+bh*0.4,wp,bh*0.6);
    ctx.fillRect(ox+bw-wp,oy+bh*0.4,wp,bh*0.6);ctx.strokeRect(ox+bw-wp,oy+bh*0.4,wp,bh*0.6);
    ctx.fillStyle='#00CCFF';ctx.font='6px monospace';ctx.textAlign='center';
    ctx.fillText('WW',ox+wp/2,oy+bh*0.72);ctx.fillText('WW',ox+bw-wp/2,oy+bh*0.72);
  }
  ctx.fillStyle='rgba(255,208,0,.75)';ctx.font='bold 8px monospace';ctx.textAlign='center';
  if(iw)ctx.fillText(iw+'" W',ox+bw/2,oy+bh/2+3);
  if(ih){ctx.save();ctx.translate(ox-10,oy+bh/2);ctx.rotate(-Math.PI/2);ctx.fillText(ih+'" H',0,0);ctx.restore();}
  if(id2){ctx.strokeStyle='rgba(255,208,0,.2)';ctx.setLineDash([2,4]);ctx.beginPath();ctx.moveTo(ox,oy+bh+10);ctx.lineTo(ox+bw,oy+bh+10);ctx.stroke();ctx.setLineDash([]);ctx.fillText(id2+'" D',ox+bw/2,oy+bh+22);}
}

/* === BOOT === */
// Normalize xm → xmax across the subwoofer database so calculations see a consistent field
if(typeof SUB_DB!=='undefined'){Object.keys(SUB_DB).forEach(function(bk){SUB_DB[bk].forEach(function(s){if(s.xm&&!s.xmax)s.xmax=s.xm;if(s.xmax&&!s.xm)s.xm=s.xmax;});});}
setBoxMode('ported');
DB_STATE = DB_STATE || {brand:'',modelIdx:-1,sizeFilter:'',search:''};
// Load Three.js for 3D viewer
if(window.THREE){ init3DViewer(); }
else { window.addEventListener('load', function(){ if(window.THREE) init3DViewer(); }); }
quoteRun();
cmpRenderSlots();
renderPresets();

// 1998 Dodge Dakota Club Cab + 2x CT Sounds Tropo-12
(function(){
  sv("t_rms", 650);  sv("t_sz", 12); sv("t_ohms", 2);
  sv("t_dvc", "dvc"); sv("t_sens", 86.3); sv("t_qty", 2);
  sv("b_disp", 0.12); sv("af_vol", 1.0); sv("af_tune", 34);
  sv("sp_s", 86.3); sv("sp_w", 650); sv("sp_n", 2);
  sv("bp4_fs", 33.5); sv("bp6_fs", 33.5);
  sv("bp4_qts", 0.52); sv("bp6_qts", 0.52);
  sv("bp4_vas", 38.1); sv("bp6_vas", 38.1);
  sv("b_w", 45); sv("b_h", 15); sv("b_d", 18);  // Dakota: 45.1" between wheel wells
  sv("e_rms", 1300); sv("e_alt", 75);
  sv("bt_w", 45); sv("bt_h", 14); sv("bt_gap", 2.0);  // Dakota: 45.1" between wells, 2" gap
  sv("bt_netvol", 2.0);
})();
lsync();
wireRun();
elecRun();
splRun();
cutsRun();
dbRenderAll();
tkUpd();
tkDraw(0,0,0,0,0,0);

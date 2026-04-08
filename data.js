// BassForge — data.js
// Port config, materials, presets, wire lookup tables.

const PORT_LIB={
  slot:{ name:'Standard Slot', endCorr:0.823, maxVel:17, warnVel:14, desc:'Standard wood slot port. Lowest noise floor.' },
  aero:{ name:'Aeroport (Round)', endCorr:0.613, maxVel:24, warnVel:20, desc:'Precision round tube. Handles higher velocity due to round edges.' },
  kerf:{ name:'Kerf-Fold Slot',   endCorr:0.732, maxVel:21, warnVel:17, desc:'Rounded wood corner. Good balance of airflow and build simplicity.' },
};
const MATS={
  mdf50:  {t:0.50,label:'1/2" MDF',       cost:30},
  mdf75:  {t:0.75,label:'3/4" MDF',       cost:42},
  mdf1:   {t:1.00,label:'1" MDF',          cost:55},
  birch75:{t:0.75,label:'3/4" Birch Ply',  cost:75},
  baltic: {t:0.75,label:'3/4" Baltic Birch',cost:95},
};
const PRESETS=[
  {name:'Single 12 Daily', tag:'DAILY', tc:'dt', qty:1,sz:12,rms:600, disp:0.14,vol:2.0, tune:33,pw:3.0, sens:87,ohms:4,dvc:'dvc',coil:'parallel',subs:'parallel'},
  {name:'Dual 12 Daily',   tag:'DAILY', tc:'dt', qty:2,sz:12,rms:1200,disp:0.14,vol:4.0, tune:33,pw:4.0, sens:87,ohms:2,dvc:'dvc',coil:'parallel',subs:'parallel'},
  {name:'Single 15 SPL',   tag:'SPL',   tc:'st', qty:1,sz:15,rms:2000,disp:0.21,vol:3.5, tune:38,pw:4.0, sens:88,ohms:2,dvc:'dvc',coil:'parallel',subs:'parallel'},
  {name:'Dual 15 SPL',     tag:'SPL',   tc:'st', qty:2,sz:15,rms:4000,disp:0.21,vol:7.0, tune:38,pw:5.0, sens:88,ohms:2,dvc:'dvc',coil:'parallel',subs:'parallel'},
  {name:'Single 10 SQ',    tag:'SQ',    tc:'qt', qty:1,sz:10,rms:500, disp:0.09,vol:1.25,tune:30,pw:2.5, sens:86,ohms:4,dvc:'dvc',coil:'series',  subs:'parallel'},
  {name:'Single 18 Comp',  tag:'COMP',  tc:'ct2',qty:1,sz:18,rms:5000,disp:0.38,vol:7.0, tune:42,pw:6.0, sens:90,ohms:1,dvc:'dvc',coil:'parallel',subs:'parallel'},
];
const WL={'2/0':'2/0 AWG','1/0':'1/0 AWG','2AWG':'2 AWG','4AWG':'4 AWG','8AWG':'8 AWG'};
const AC_EFF={d:0.85,ab:0.55,a:0.30};
const AC_NOTES={
  d:'Class D: Most efficient for subs. 85% power → bass, 15% → heat.',
  ab:'Class AB: Full range amps. 55% efficiency — plan for more current draw and heat.',
  a:'Class A: Audiophile grade. Only 30% efficient. Massive heat & current — rare in car audio.',
};

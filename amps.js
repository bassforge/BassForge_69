// BassForge — amps.js
// Amplifier database. Add amps here.

window.AMP_BRAND_NAMES = {
  sundown:   'Sundown Audio',
  taramps:   'Taramps',
  skar:      'Skar Audio',
  jl_audio:  'JL Audio',
  kicker:    'Kicker',
  ct_sounds: 'CT Sounds',
  d4s:       'Down4Sound',
  // ADD NEW AMP BRAND NAMES HERE
};

window.AMP_DB = {
  sundown: [
    {model:"SFB-600D",  rms_1ohm:600,  rms_2ohm:350,  rms_4ohm:250,  class:"D",type:"mono",strappable:false,price:150, tier:"budget"},
    {model:"SFB-1000D", rms_1ohm:1000, rms_2ohm:650,  rms_4ohm:350,  class:"D",type:"mono",strappable:false,price:200, tier:"mid"},
    {model:"SFB-1500D", rms_1ohm:1500, rms_2ohm:900,  rms_4ohm:500,  class:"D",type:"mono",strappable:false,price:260, tier:"mid"},
    {model:"SFB-2000D", rms_1ohm:2000, rms_2ohm:1200, rms_4ohm:650,  class:"D",type:"mono",strappable:false,price:330, tier:"mid"},
    {model:"SFB-3000D", rms_1ohm:3000, rms_2ohm:1800, rms_4ohm:1000, class:"D",type:"mono",strappable:false,price:420, tier:"mid"},
    {model:"SIA-1250D", rms_1ohm:1250, rms_2ohm:1250, rms_4ohm:800,  class:"D",type:"mono",strappable:false,price:null,tier:"mid"},
    {model:"SIA-3500D", rms_1ohm:3500, rms_2ohm:3300, rms_4ohm:2600, class:"D",type:"mono",strappable:false,price:null,tier:"premium"},
    // ADD NEW sundown AMPS HERE
  ],
  taramps: [
    {model:"MD 1200.1",    rms_1ohm:1200, rms_2ohm:720,  rms_4ohm:390,  class:"D",type:"mono",strappable:false,price:140, tier:"budget"},
    {model:"MD 1800.1",    rms_1ohm:1800, rms_2ohm:1000, rms_4ohm:600,  class:"D",type:"mono",strappable:false,price:180, tier:"budget"},
    {model:"MD 3000.1",    rms_1ohm:3000, rms_2ohm:1920, rms_4ohm:1100, class:"D",type:"mono",strappable:false,price:230, tier:"mid"},
    {model:"MD 5000.1",    rms_1ohm:5000, rms_2ohm:3200, rms_4ohm:2000, class:"D",type:"mono",strappable:false,price:420, tier:"mid"},
    {model:"Smart 3 Bass", rms_1ohm:3000, rms_2ohm:3000, rms_4ohm:null, class:"D",type:"mono",strappable:false,price:260, tier:"mid"},
    {model:"Smart 5 Bass", rms_1ohm:5000, rms_2ohm:5000, rms_4ohm:null, class:"D",type:"mono",strappable:false,price:479, tier:"mid"},
    {model:"BASS 1200 1",  rms_1ohm:1200, rms_2ohm:null, rms_4ohm:null, class:"D",type:"mono",strappable:false,price:100, tier:"budget"},
    // ADD NEW taramps AMPS HERE
  ],
  skar: [
    {model:"RP-800.1D",   rms_1ohm:800,  rms_2ohm:600,  rms_4ohm:300,  class:"D",type:"mono",strappable:false,price:130, tier:"budget"},
    {model:"RP-1200.1D",  rms_1ohm:1200, rms_2ohm:800,  rms_4ohm:400,  class:"D",type:"mono",strappable:false,price:160, tier:"budget"},
    {model:"RP-1500.1D",  rms_1ohm:1500, rms_2ohm:900,  rms_4ohm:500,  class:"D",type:"mono",strappable:false,price:180, tier:"budget"},
    {model:"RP-2000.1D",  rms_1ohm:2000, rms_2ohm:1400, rms_4ohm:700,  class:"D",type:"mono",strappable:false,price:260, tier:"mid"},
    {model:"ZVX-5500.1D", rms_1ohm:5500, rms_2ohm:3300, rms_4ohm:1800, class:"D",type:"mono",strappable:true, price:null,tier:"premium"},
    // ADD NEW skar AMPS HERE
  ],
  jl_audio: [
    {model:"RD500/1",  rms_1ohm:null, rms_2ohm:500,  rms_4ohm:250,  class:"D",type:"mono",strappable:false,price:300, tier:"premium"},
    {model:"RD1000/1", rms_1ohm:null, rms_2ohm:1000, rms_4ohm:600,  class:"D",type:"mono",strappable:false,price:450, tier:"premium"},
    {model:"RD1500/1", rms_1ohm:1500, rms_2ohm:1500, rms_4ohm:750,  class:"D",type:"mono",strappable:false,price:600, tier:"premium"},
    {model:"HD750/1",  rms_1ohm:null, rms_2ohm:750,  rms_4ohm:750,  class:"D",type:"mono",strappable:false,price:null,tier:"premium"},
    {model:"HD1200/1", rms_1ohm:null, rms_2ohm:1200, rms_4ohm:1200, class:"D",type:"mono",strappable:false,price:null,tier:"premium"},
    // ADD NEW jl_audio AMPS HERE
  ],
  kicker: [
    {model:"CXA400.1",  rms_1ohm:400,  rms_2ohm:300,  rms_4ohm:200, class:"D",type:"mono",strappable:false,price:null,tier:"budget"},
    {model:"CXA800.1",  rms_1ohm:800,  rms_2ohm:600,  rms_4ohm:300, class:"D",type:"mono",strappable:false,price:null,tier:"budget"},
    {model:"CXA1200.1", rms_1ohm:1200, rms_2ohm:1200, rms_4ohm:600, class:"D",type:"mono",strappable:false,price:null,tier:"mid"},
    {model:"CXA1800.1", rms_1ohm:1800, rms_2ohm:1200, rms_4ohm:700, class:"D",type:"mono",strappable:false,price:null,tier:"mid"},
    // ADD NEW kicker AMPS HERE
  ],
  ct_sounds: [
    {model:"STRATO 1.5K",  rms_1ohm:1500, rms_2ohm:1000, rms_4ohm:600,  class:"D",type:"mono",strappable:false,price:null,tier:"mid"},
    {model:"STRATO 4K",    rms_1ohm:4000, rms_2ohm:2400, rms_4ohm:1400, class:"D",type:"mono",strappable:false,price:null,tier:"mid"},
    {model:"TROPO 1200.1", rms_1ohm:1200, rms_2ohm:800,  rms_4ohm:450,  class:"D",type:"mono",strappable:false,price:null,tier:"mid"},
    // ADD NEW ct_sounds AMPS HERE
  ],
  d4s: [
    // NOTE: JP23 v2 had duplicate rms_1ohm keys (2800 and 1800) in source data.
    // Used 1800 (second value, JS behavior). VERIFY against your specs and fix Excel.
    {model:"JP8 v1.5", rms_1ohm:850,  rms_2ohm:650,  rms_4ohm:490,  class:"D",type:"mono",strappable:true, price:220, tier:"mid"},
    {model:"JP23 v2",  rms_1ohm:1800, rms_2ohm:null, rms_4ohm:1000, class:"D",type:"mono",strappable:true, price:330, tier:"mid"},
    {model:"JP30",     rms_1ohm:3000, rms_2ohm:2000, rms_4ohm:1100, class:"D",type:"mono",strappable:true, price:null,tier:"mid"},
    // ADD NEW d4s AMPS HERE
  ],
  // ADD NEW AMP BRANDS HERE
};

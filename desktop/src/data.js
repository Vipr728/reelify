/* ============ REELIFY — mock data ============ */
const REELIFY_DATA = (function () {
  // gradient palettes for thumbnails / avatars (no real imagery available)
  const grads = [
    "linear-gradient(135deg,#3A2E1F,#7A5A2E)",
    "linear-gradient(135deg,#1F2E33,#2E6A7A)",
    "linear-gradient(135deg,#33212E,#7A2E5E)",
    "linear-gradient(135deg,#2E331F,#5E7A2E)",
    "linear-gradient(135deg,#2A1F33,#5A2E7A)",
    "linear-gradient(135deg,#331F1F,#7A3A2E)",
    "linear-gradient(135deg,#1F3329,#2E7A56)",
    "linear-gradient(135deg,#2E2A1F,#7A6A2E)",
  ];

  const clips = [
    { id:"c1", name:"A-roll_studio_intro.mov", dur:"02:41", res:"4K", size:"1.8 GB", grad:grads[0], sel:true, kind:"A-roll" },
    { id:"c2", name:"interview_main_take3.mov", dur:"14:22", res:"4K", size:"6.2 GB", grad:grads[1], sel:true, kind:"Interview" },
    { id:"c3", name:"broll_desk_hands.mov", dur:"01:08", res:"4K", size:"640 MB", grad:grads[3], sel:true, kind:"B-roll" },
    { id:"c4", name:"broll_city_window.mov", dur:"00:52", res:"4K", size:"480 MB", grad:grads[6], sel:true, kind:"B-roll" },
    { id:"c5", name:"product_demo_screen.mov", dur:"03:30", res:"1080p", size:"1.1 GB", grad:grads[7], sel:true, kind:"Screen" },
    { id:"c6", name:"outro_signoff.mov", dur:"00:38", res:"4K", size:"410 MB", grad:grads[5], sel:false, kind:"A-roll" },
    { id:"c7", name:"bts_phone_vertical.mov", dur:"01:55", res:"1080p", size:"520 MB", grad:grads[4], sel:false, kind:"B-roll" },
  ];

  const boxTree = [
    { name:"Projects", open:true },
    { name:"Q2 Launch Film", open:true, active:true, depth:1 },
    { name:"Raw — May shoot", depth:2 },
    { name:"Exports", depth:2 },
    { name:"Brand Assets", depth:1 },
    { name:"Archive 2025", depth:1 },
  ];

  // selectable Box folders (import page picks folders, not individual clips)
  const boxFolders = [
    { id:"f1", name:"Raw — May shoot", path:"Q2 Launch Film", clips:7, dur:"23:11", res:"4K", sel:true },
    { id:"f2", name:"Founder interviews", path:"Q2 Launch Film", clips:3, dur:"41:20", res:"4K" },
    { id:"f3", name:"B-roll library", path:"Brand Assets", clips:24, dur:"18:40", res:"4K" },
    { id:"f4", name:"Product demos", path:"Q2 Launch Film", clips:5, dur:"12:30", res:"1080p" },
    { id:"f5", name:"Archive 2025", path:"Workspace", clips:61, dur:"3:42:10", res:"Mixed" },
  ];

  // transcript segments revealed in step 2
  const transcript = [
    { t:"00:04", clip:"A-roll", text:"So the thing nobody tells you about building in public is that the audience comes for the product but stays for the decisions." },
    { t:"01:12", clip:"Interview", text:"We made every roadmap call in the open. People could see why we killed features. That transparency became the moat." },
    { t:"03:48", clip:"Interview", text:"Distribution isn't a megaphone. It's a hundred small conversations that compound. Most founders quit at conversation nine." },
    { t:"07:20", clip:"Interview", text:"The first thousand users taught us more than any analytics dashboard. We just had to actually read the messages." },
    { t:"11:05", clip:"Screen", text:"Here's the dashboard. Notice we surface the why behind every metric, not just the number." },
  ];

  const topics = [
    { label:"Building in public", w:96 },
    { label:"Founder-led growth", w:88 },
    { label:"Distribution", w:81 },
    { label:"Early users", w:74 },
    { label:"Product strategy", w:69 },
    { label:"Transparency", w:58 },
  ];

  const throughline = "A founder's case for building in public — why transparency around hard decisions compounds into distribution, told through the first 1,000 users.";

  // matched creators
  const creators = [
    {
      id:"v1", handle:"@nadiabuilds", name:"Nadia Okonkwo", niche:"Founder-led growth",
      followers:"412K", platform:"Instagram + TikTok", match:94, grad:grads[2], color:"#FF6A45",
      reels:312, shared:["Building in public","Distribution","Early users"],
      blurb:"Cuts founder interviews into punchy, caption-forward reels. Fast but never frantic.",
    },
    {
      id:"v2", handle:"@thequietfounder", name:"Marcus Lee", niche:"Product strategy",
      followers:"189K", platform:"YouTube Shorts", match:89, grad:grads[1], color:"#7A9CFF",
      reels:204, shared:["Product strategy","Transparency"],
      blurb:"Calmer, essayistic pacing. Big kinetic type, minimal music, lots of breathing room.",
    },
    {
      id:"v3", handle:"@growthwithzo", name:"Zoё Hart", niche:"Distribution tactics",
      followers:"628K", platform:"TikTok", match:86, grad:grads[4], color:"#C77AFF",
      reels:540, shared:["Distribution","Founder-led growth"],
      blurb:"High-energy, jump-cut heavy, bold captions and trending audio. Built for the scroll.",
    },
    {
      id:"v4", handle:"@buildlog", name:"Priya & Sam", niche:"Building in public",
      followers:"97K", platform:"Instagram", match:78, grad:grads[6], color:"#4FD6A0",
      reels:148, shared:["Building in public","Early users"],
      blurb:"Documentary feel. Warm grade, ambient music, generous b-roll, restrained captions.",
    },
  ];

  // style DNA per creator — numeric axes 0..100 + descriptive fields (distinct keys!)
  const styleDNA = {
    v1: { cutRate:78, captions:92, grade:64, music:70, broll:48, hook:88, punch:74,
      cutsMin:"11/min", capStyle:"Word-pop, centered", gradeName:"Warm punch", musicName:"Upbeat lo-fi",
      hookDesc:"Cold open on the boldest line", gradeCss:"linear-gradient(135deg,#FFB36A,#FF6A45)" },
    v2: { cutRate:46, captions:74, grade:52, music:38, broll:62, hook:60, punch:44,
      cutsMin:"6/min", capStyle:"Kinetic lower-third", gradeName:"Neutral film", musicName:"Ambient pad",
      hookDesc:"Question first, answer slow", gradeCss:"linear-gradient(135deg,#9CB0C9,#5A7290)" },
    v3: { cutRate:94, captions:96, grade:80, music:92, broll:30, hook:96, punch:90,
      cutsMin:"16/min", capStyle:"Bouncing karaoke", gradeName:"Hyper-saturated", musicName:"Trending audio",
      hookDesc:"Pattern interrupt in 0.5s", gradeCss:"linear-gradient(135deg,#FF7AE0,#C77AFF)" },
    v4: { cutRate:34, captions:48, grade:58, music:30, broll:82, hook:42, punch:28,
      cutsMin:"4/min", capStyle:"Minimal, bottom", gradeName:"Warm documentary", musicName:"Ambient strings",
      hookDesc:"Let the scene set itself", gradeCss:"linear-gradient(135deg,#E8C98A,#B98A4F)" },
  };

  const dnaAxes = [
    { key:"cutRate", label:"Cuts" },
    { key:"hook", label:"Hook" },
    { key:"captions", label:"Captions" },
    { key:"music", label:"Music" },
    { key:"punch", label:"Punch-ins" },
    { key:"grade", label:"Grade" },
    { key:"broll", label:"B-roll" },
  ];

  // their sample reels (vertical)
  const sampleReels = {
    v1:[{g:grads[0],dur:"0:31",views:"1.2M",cap:"the moat nobody copies"},{g:grads[2],dur:"0:44",views:"880K",cap:"i read every dm"},{g:grads[5],dur:"0:27",views:"2.1M",cap:"kill the feature"}],
    v2:[{g:grads[1],dur:"0:52",views:"410K",cap:"slow distribution"},{g:grads[7],dur:"0:48",views:"320K",cap:"the why > the number"},{g:grads[3],dur:"0:39",views:"190K",cap:"strategy is subtraction"}],
    v3:[{g:grads[4],dur:"0:21",views:"3.4M",cap:"STOP scrolling"},{g:grads[2],dur:"0:18",views:"5.1M",cap:"do this NOW"},{g:grads[5],dur:"0:24",views:"2.8M",cap:"founders HATE this"}],
    v4:[{g:grads[6],dur:"1:02",views:"120K",cap:"day 400 of building"},{g:grads[0],dur:"0:58",views:"98K",cap:"first 1000 users"},{g:grads[3],dur:"0:51",views:"76K",cap:"in the open"}],
  };

  // timeline clips for the studio (assembled cut)
  const timeline = [
    { id:"t1", lane:0, start:0, len:10, label:"Cold open · bold line", clip:"Interview", color:"var(--coral)" },
    { id:"t2", lane:0, start:10, len:14, label:"A-roll intro", clip:"A-roll", color:"#7A9CFF" },
    { id:"t3", lane:0, start:24, len:20, label:"Interview · the moat", clip:"Interview", color:"#7A9CFF" },
    { id:"t4", lane:0, start:44, len:9, label:"B-roll · hands", clip:"B-roll", color:"#4FD6A0" },
    { id:"t5", lane:0, start:53, len:18, label:"Interview · 1000 users", clip:"Interview", color:"#7A9CFF" },
    { id:"t6", lane:0, start:71, len:12, label:"Screen · dashboard", clip:"Screen", color:"#C77AFF" },
    { id:"t7", lane:0, start:83, len:7, label:"Outro signoff", clip:"A-roll", color:"#7A9CFF" },
  ];
  const captionsLane = [
    { start:1, len:8, text:"the audience stays for the decisions" },
    { start:11, len:11, text:"building in public" },
    { start:26, len:16, text:"transparency became the moat" },
    { start:54, len:15, text:"the first 1,000 users" },
    { start:72, len:14, text:"the why behind every number" },
  ];

  const captionCues = [
    { at:8, text:"the audience stays for the\nDECISIONS" },
    { at:30, text:"transparency became\nthe MOAT" },
    { at:55, text:"the first 1,000 users\ntaught us everything" },
    { at:78, text:"the WHY behind\nevery number" },
  ];

  return { grads, clips, boxTree, boxFolders, transcript, topics, throughline, creators, styleDNA, dnaAxes, sampleReels, timeline, captionsLane, captionCues };
})();

export default REELIFY_DATA;

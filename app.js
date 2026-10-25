// The portal itself + healing mechanisms: retry/backoff, circuit breaker, cache fallback, load shedding, self-repairing data.
const express=require('express'),path=require('path'),db=require('./db'),healing=require('./flags'),crypto=require('crypto'),PDFDocument=require('pdfkit');
const SUP='http://localhost:5200',MAX=120,cache=new Map(),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const busy=ms=>{const e=Date.now()+ms;while(Date.now()<e);}; // simulates CPU cost of rendering a marksheet
const post=b=>fetch(SUP+'/internal/incident',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).catch(()=>{});
const inc={open(k,m){const id=k+'-'+Date.now()+Math.floor(Math.random()*99);post({id,kind:k,stage:'detected',msg:m,t:Date.now()});return id},
 step(id,s,m){post({id,kind:id.split('-')[0],stage:s,msg:m,t:Date.now()})}};
// ---- DB access with timing ----
let lastDbMs=0,dbErr=false;
const q=async r=>{const t=Date.now();try{const x=await db.query(r);dbErr=false;return x}catch(e){dbErr=true;throw e}finally{lastDbMs=Date.now()-t}};
const timeout=(p,ms)=>Promise.race([p,new Promise((_,j)=>setTimeout(()=>j(new Error('DB timeout')),ms))]);
// ---- Mechanism 2: retry with exponential backoff ----
async function retry(fn,n=3){let d=100;for(let i=1;;i++){try{return await fn()}catch(e){if(e.open||i>=n)throw e;await sleep(d);d*=2}}}
// ---- Mechanism 3: circuit breaker ----
const cb={state:'CLOSED',fails:0,openedAt:0,id:null};
async function guarded(fn){
 if(cb.state==='OPEN'){if(Date.now()-cb.openedAt<3000)throw Object.assign(new Error('circuit open'),{open:true});cb.state='HALF'}
 try{const r=await fn();
  if(cb.state!=='CLOSED'){cb.state='CLOSED';inc.step(cb.id,'recovered','Probe succeeded: circuit CLOSED, live data again');cb.id=null}
  cb.fails=0;return r}
 catch(e){cb.fails++;
  if(cb.state!=='OPEN'&&(cb.state==='HALF'||cb.fails>=3)){cb.state='OPEN';cb.openedAt=Date.now();
   if(!cb.id){const id=cb.id=inc.open('db',cb.fails+' consecutive DB failures');inc.step(id,'diagnosed','Database slow or unreachable: '+e.message);
   setTimeout(()=>{db.state.latencyMs=0;db.state.down=false;inc.step(id,'action','Failover: connection pool reset to a healthy replica (simulated)')},2500)}
   inc.step(cb.id,'action','Circuit OPEN: failing fast, serving cached results, probing every few seconds')}
  throw e}}
// background probe: detects DB trouble even with no user traffic
setInterval(()=>{healing()?guarded(()=>timeout(q('1001'),1200)).catch(()=>{}):q('1001').catch(()=>{})},1000);
// ---- Mechanism 6: self-repairing data ----
function repair(roll){const cur=db.peek(roll);if(db.valid(cur))return cur;
 const id=inc.open('data','Integrity check failed for roll '+roll);
 inc.step(id,'diagnosed','Checksum/range mismatch (marks outside 0–100 or tampered)');
 const r=db.restore(roll);
 if(r){inc.step(id,'action','Bad row quarantined; restored from verified backup');inc.step(id,'recovered','Roll '+roll+' verified OK');return r}
 inc.step(id,'action','Row quarantined; result put on hold (“under verification”)');
 inc.step(id,'failed','Backup copy is corrupt too: cannot self-repair, human needed');return null}
setInterval(()=>{if(healing())db.bad().forEach(repair)},3000);
// ---- Mechanism 4: fallback to cached last-known data ----
async function fetchRec(roll){
 if(!healing())return{rec:await q(roll),src:'db'};
 try{const rec=await retry(()=>guarded(()=>timeout(q(roll),1200)));
  if(rec&&!rec.held&&!db.valid(rec)){const f=repair(roll);return f?{rec:f,src:'repaired'}:{rec:{held:true}}}
  if(rec&&!rec.held)cache.set(roll,rec);
  return{rec,src:'db'}}
 catch(e){const c=cache.get(roll);if(c)return{rec:c,src:'cache',stale:true};throw e}}
db.all().forEach(r=>cache.set(r.roll,r)); // warm cache at startup (Redis in a real system)
// ---- Mechanism 7: load shedding ----
let win=0,rps=0,shedInc=null,lastShed=0,surgeUntil=0;
setInterval(()=>{rps=win;win=0;if(shedInc&&Date.now()-lastShed>3000){inc.step(shedInc,'recovered','Traffic back under limit; shedding stopped');shedInc=null}},1000);
const app=express();let published=db.getSetting('published')!=='0',pdfBroken=false,printBroken=false;
app.get('/healthz',(req,res)=>res.json({ok:1,pid:process.pid,cb:cb.state,rps,shedding:!!shedInc,pdfBroken,printBroken,held:db.held.size,bad:db.bad().length,dbMs:lastDbMs,dbErr,healing:healing()}));
app.get('/mode',(req,res)=>res.json({healing:healing(),pdfBroken,printBroken,surge:Date.now()<surgeUntil}));
app.use('/api',(req,res,next)=>{win++;if(win>MAX)surgeUntil=Date.now()+4000;
 if(healing()&&win>MAX){lastShed=Date.now();
  if(!shedInc){shedInc=inc.open('traffic','Request rate exceeded '+MAX+'/s');inc.step(shedInc,'diagnosed','Traffic spike (about 10× normal)');inc.step(shedInc,'action','Load shedding: 429 + Retry-After; portal clients queue and retry')}
  return res.set('Retry-After','2').status(429).json({error:'busy',retryAfter:2})}
 next()});
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'public/portal.html')));
app.use('/fonts',express.static(path.join(__dirname,'public/fonts'),{maxAge:'7d'}));
app.get('/theme.js',(req,res)=>res.sendFile(path.join(__dirname,'public/theme.js')));
app.get('/theme.css',(req,res)=>res.sendFile(path.join(__dirname,'public/theme.css')));
const shape=(rec,src,stale)=>{const c=db.calc(rec.marks);return{roll:rec.roll,name:rec.name,subjects:db.SUBJECTS.map((n,i)=>({name:n,marks:rec.marks[i],pass:rec.marks[i]>=40})),total:c.total,max:500,percent:c.percent,grade:c.grade,pass:c.pass,src,stale:!!stale}};
async function lookup(roll){busy(3);
 if(!/^\d{4}$/.test(roll))return{s:400,e:'Roll number must be 4 digits'};
 if(!published)return{s:403,e:'Results are not published yet. Please check back at the announced time.'};
 try{const{rec,src,stale}=await fetchRec(roll);
  if(!rec)return{s:404,e:'No result found for this roll number'};
  if(rec.held)return{s:423,e:'on hold'};
  return{s:200,d:shape(rec,src,stale)}}catch(e){return{s:500,e:'Service error: '+e.message}}}
app.get('/api/result/:roll',async(req,res)=>{const r=await lookup(req.params.roll);r.s===200?res.json(r.d):res.status(r.s).json({error:r.e})});
function pdf(res,d){const doc=new PDFDocument({size:'A4',margin:56});
 res.set({'Content-Type':'application/pdf','Content-Disposition':'attachment; filename=Result_'+d.roll+'.pdf'});doc.pipe(res);
 doc.font('Helvetica-Bold').fontSize(20).text('Semester Examination Result');
 doc.font('Helvetica').fontSize(10).fillColor('#555').text('Provisional marksheet. Generated '+new Date().toLocaleString()).moveDown(1.5);
 doc.fillColor('#000').font('Helvetica-Bold').fontSize(15).text(d.name);doc.font('Helvetica').fontSize(11).text('Roll number: '+d.roll).moveDown();
 let y=doc.y+6;const row=(a,b,c,bold)=>{doc.font(bold?'Helvetica-Bold':'Helvetica').fontSize(11).fillColor('#000').text(a,56,y,{lineBreak:false}).text(b,330,y,{lineBreak:false}).text(c,430,y,{lineBreak:false});y+=26;doc.moveTo(56,y-8).lineTo(540,y-8).strokeColor('#ccc').stroke()};
 row('Subject','Marks','Status',1);d.subjects.forEach(s=>row(s.name,s.marks+' / 100',s.pass?'Pass':'Fail'));row('Total',d.total+' / '+d.max,'',1);
 doc.font('Helvetica-Bold').fontSize(13).fillColor('#000').text('Percentage: '+d.percent+'%     Grade: '+d.grade+'     Result: '+(d.pass?'PASS':'FAIL'),56,y+10);
 if(d.stale)doc.font('Helvetica').fontSize(9).fillColor('#a05a00').text('Generated from the last saved copy while the live database was unavailable.',56,y+40);
 doc.end()}
app.get('/api/result/:roll/pdf',async(req,res)=>{const r=await lookup(req.params.roll);if(r.s!==200)return res.status(r.s).json({error:r.e});
 for(let n=1;;n++){if(!pdfBroken)return pdf(res,r.d); // PDF engine fault: with healing ON, wait for the repair and retry (takes a few seconds)
  if(!healing()||n>=5)return res.status(500).json({error:'The PDF service is down.'+(healing()?' Self-healing is still repairing it, try again in a moment.':'')});await sleep(1500)}});
// ---- Admin panel: upload and manage student results (password: env ADMIN_KEY, default admin123) ----
app.use(express.json({limit:'10mb'}));
const KEY=process.env.ADMIN_KEY||'admin123',sign=e=>crypto.createHmac('sha256',KEY+'|results-portal').update(String(e)).digest('hex'),fails=new Map();
const cookie=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(c=>c.trim().split('=')).filter(p=>p[0]));
const authed=req=>{const[e,s]=(cookie(req).adm||'').split('.');if(!e||!s||+e<Date.now())return false;const x=Buffer.from(s),y=Buffer.from(sign(e));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
const auth=(req,res,next)=>authed(req)?next():res.status(401).json({error:'Please sign in again'});
app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'public',authed(req)?'admin.html':'login.html')));
app.post('/admin/login',(req,res)=>{const f=fails.get(req.ip)||{n:0,until:0};if(Date.now()<f.until)return res.status(429).json({error:'Too many attempts. Wait 30 seconds and try again.'});
 const x=Buffer.from(String(req.body.password||'')),y=Buffer.from(KEY);
 if(!(x.length===y.length&&crypto.timingSafeEqual(x,y))){f.n++;if(f.n>=5){f.until=Date.now()+30000;f.n=0}fails.set(req.ip,f);return res.status(401).json({error:'Wrong password'})}
 fails.delete(req.ip);const e=Date.now()+8*3600e3;res.cookie('adm',e+'.'+sign(e),{httpOnly:true,sameSite:'strict',path:'/admin',maxAge:8*3600e3});res.json({ok:1})});
app.post('/admin/logout',(req,res)=>{res.clearCookie('adm',{path:'/admin'});res.json({ok:1})});
const readXlsx=require('read-excel-file/node');
app.post('/admin/api/parse-xlsx',auth,async(req,res)=>{try{const rows=await readXlsx(Buffer.from(req.body.data||'','base64'));
 res.json({csv:rows.map(r=>r.slice(0,7).map(c=>String(c??'').replace(/,/g,' ')).join(',')).join('\n')})}
 catch(e){res.status(400).json({error:'Could not read the Excel file. Use .xlsx with columns: roll, name, marks.'})}});
app.get('/admin/api/students',auth,(req,res)=>res.json(db.all().sort((a,b)=>a.roll-b.roll).map(r=>({roll:r.roll,name:r.name,marks:r.marks||[],...db.calc(r.marks),held:db.held.has(r.roll)}))));
app.post('/admin/api/students',auth,(req,res)=>{const out=db.upsert(Array.isArray(req.body.rows)?req.body.rows:[]);out.rolls.forEach(r=>cache.set(r,db.peek(r)));res.json(out)});
app.get('/admin/api/stats',auth,(req,res)=>res.json({published,subjects:db.SUBJECTS,stats:db.stats(),audit:db.auditList(12),quarantine:db.quarantineList(8)}));
app.post('/admin/api/publish',auth,(req,res)=>{published=!!req.body.published;db.setSetting('published',published?'1':'0');db.audit(published?'publish':'unpublish',published?'Results made visible to students':'Results hidden from students');res.json({published})});
app.get('/admin/api/export',auth,(req,res)=>{res.type('text/csv').set('Content-Disposition','attachment; filename=results.csv').send('roll,name,'+db.SUBJECTS.join(',')+',percentage,grade\n'+db.all().map(r=>{const c=db.calc(r.marks);return[r.roll,String(r.name).replace(/,/g,' '),...(r.marks||[]),c.percent,c.grade].join(',')}).join('\n'))});
app.delete('/admin/api/students/:roll',auth,(req,res)=>{db.remove(req.params.roll);cache.delete(req.params.roll);res.json({ok:1})});
// ---- Chaos hooks (called via supervisor) ----
app.post('/chaos/:t',(req,res)=>{const t=req.params.t;res.json({ok:1});
 if(t==='dbslow')db.state.latencyMs=3000; // stays broken until healed or cleared
 if(t==='dbdown')db.state.down=true;
 if(t==='clear'){db.state.latencyMs=0;db.state.down=false;pdfBroken=false;printBroken=false}
 if(t==='pdf-fail')pdfBroken=true;
 if(t==='print-fail')printBroken=true;
 if(t==='corrupt')db.corrupt(false,req.query.roll);
 if(t==='corrupt-both')db.corrupt(true,req.query.roll);
 if(t==='reseed'){db.reseed();cache.clear();db.all().forEach(r=>cache.set(r.roll,r))}
 if(t==='crash')setTimeout(()=>process.exit(1),50);
 if(t==='freeze')setTimeout(()=>{for(;;);},50)});
// ---- Self-tests for the download and print services (heal when healing is ON) ----
const SV={download:{m:'PDF self-test failed',d:'PDF renderer has crashed',a:'Restarting the PDF renderer',b:()=>pdfBroken,f:()=>{pdfBroken=false}},
 print:{m:'Print service self-test failed',d:'Print service is unavailable',a:'Restarting print service with a print-ready layout',b:()=>printBroken,f:()=>{printBroken=false}}},svcInc={};
setInterval(()=>{if(!healing())return;for(const k in SV){const s=SV[k];if(s.b()&&!svcInc[k]){const id=svcInc[k]=inc.open(k,s.m);inc.step(id,'diagnosed',s.d);inc.step(id,'action',s.a);
 setTimeout(()=>{s.f();inc.step(id,'recovered','Self-test passing again');svcInc[k]=null},2000)}}},1000);
app.listen(5100,()=>console.log('Portal on :5100'));

// Mechanism 1: watchdog (health checks + auto restart). Also hosts dashboard, incident log, chaos API.
const {spawn}=require('child_process'),express=require('express'),fs=require('fs'),path=require('path');
fs.mkdirSync('data',{recursive:true});fs.mkdirSync('logs',{recursive:true});
const healing=require('./flags'),APP='http://localhost:5100',LOG='logs/incidents.jsonl';
const KIND={crash:'process',freeze:'process',dbslow:'db',dbdown:'db',corrupt:'data','corrupt-both':'data',flood:'traffic','pdf-fail':'download','print-fail':'print'};
const RANK={detected:0,diagnosed:1,action:2,recovered:3,failed:3};
let child,last=null,misses=0,startedAt=0,killing=false,dead=false,pinc=null,restarts=0,recoveries=0,floodStats=null;
const incidents=[],injected={};
function step(id,kind,stage,msg,t=Date.now()){let i=incidents.find(x=>x.id===id);
 if(!i){const j=injected[kind];i={id,kind,injectedAt:j&&t-j<60000&&t>=j?j:null,steps:[],state:'open'};incidents.unshift(i);if(incidents.length>50)incidents.pop()}
 i.steps.push({stage,msg,t});i.steps.sort((a,b)=>a.t-b.t||RANK[a.stage]-RANK[b.stage]);
 if(stage==='detected')i.ttd=i.injectedAt?(t-i.injectedAt)/1000:null;
 if(stage==='recovered'){i.state='recovered';i.ttr=i.injectedAt?(t-i.injectedAt)/1000:null;recoveries++}
 if(stage==='failed')i.state='unhealed';
 fs.appendFileSync(LOG,JSON.stringify({id,kind,stage,msg,at:new Date(t).toISOString()})+'\n')}
function spawnApp(){child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','app.js'],{cwd:__dirname,stdio:'inherit'});startedAt=Date.now();misses=0;
 child.on('exit',(code,sig)=>{child=null;last=null;if(killing){killing=false;return}
  if(!healing()){dead=true;return}
  pinc=pinc||'process-'+Date.now();
  step(pinc,'process','detected','Process exit event received');
  step(pinc,'process','diagnosed','Crash: exit code '+code+(sig?' signal '+sig:''));
  step(pinc,'process','action','Watchdog restarting process');restarts++;setTimeout(spawnApp,300)})}
async function poll(){
 if(!child){if(dead&&healing()){dead=false;pinc='process-'+Date.now();
   step(pinc,'process','detected','Watchdog found the process not running');
   step(pinc,'process','diagnosed','Process had exited while healing was off');
   step(pinc,'process','action','Restarting process');restarts++;spawnApp()}return}
 try{const r=await fetch(APP+'/healthz',{signal:AbortSignal.timeout(1000)});last=await r.json();misses=0;
  if(pinc){step(pinc,'process','recovered','Health check passing again');pinc=null}}
 catch{misses++;last=null;
  if(misses>=2&&healing()&&!pinc&&Date.now()-startedAt>4000){pinc='process-'+Date.now();
   step(pinc,'process','detected','2 consecutive health checks timed out');
   step(pinc,'process','diagnosed','Process alive but unresponsive: event loop frozen');
   step(pinc,'process','action','SIGKILL and restart');killing=true;restarts++;child.kill('SIGKILL');setTimeout(spawnApp,300)}}}
let flooding=false;
async function flood(){if(flooding)return;flooding=true;const N=1500,end=Date.now()+30000;let tot=0,ok=0,shed=0,err=0; // waves of 1500 requests until stopped (30 s cap)
 while(flooding&&Date.now()<end){await Promise.all(Array.from({length:N},async(_,i)=>{try{const r=await fetch(APP+'/api/result/'+(1001+i%200),{signal:AbortSignal.timeout(8000)});r.status===200?ok++:r.status===429?shed++:err++}catch{err++}}));tot+=N;floodStats={N:tot,ok,shed,err,running:true};await new Promise(r=>setTimeout(r,1500))}
 flooding=false;floodStats={N:tot,ok,shed,err,running:false}}
const app=express();app.use(express.json());
app.use((req,res,next)=>{res.set({'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS'});req.method==='OPTIONS'?res.end():next()}); // lets the student page send demo chaos
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'public/dashboard.html')));
app.use('/fonts',express.static(path.join(__dirname,'public/fonts'),{maxAge:'7d'}));
app.get('/theme.css',(req,res)=>res.sendFile(path.join(__dirname,'public/theme.css')));
app.get('/api/status',(req,res)=>res.json({healing:healing(),recoveries,restarts,floodStats,app:last,
 proc:!child?'down':last?'up':(Date.now()-startedAt<4000?'starting':'unresponsive'),incidents}));
app.get('/api/probe/:roll',async(req,res)=>{const t=Date.now();try{const r=await fetch(APP+'/api/result/'+encodeURIComponent(req.params.roll),{signal:AbortSignal.timeout(5000)});res.json({status:r.status,ms:Date.now()-t,body:await r.json()})}catch(e){res.json({status:0,ms:Date.now()-t,body:{error:'app unreachable'}})}});
app.post('/internal/incident',(req,res)=>{const b=req.body;step(b.id,b.kind,b.stage,b.msg,b.t);res.end()});
app.post('/chaos/:t',async(req,res)=>{const t=req.params.t;
 if(t==='healing-off'||t==='healing-on'){t==='healing-off'?fs.writeFileSync('data/healing.off','1'):fs.rmSync('data/healing.off',{force:true});return res.json({ok:1})}
 if(t==='stop-flood'){flooding=false;return res.json({ok:1})}
 if(t==='clear')flooding=false;
 if(t!=='reseed'&&t!=='clear'){if(!KIND[t])return res.status(404).json({error:'unknown'});injected[KIND[t]]=Date.now()}
 if(t==='flood'){flood();return res.json({ok:1})}
 try{await fetch(APP+'/chaos/'+t+(req.query.roll?'?roll='+encodeURIComponent(req.query.roll):''),{method:'POST',signal:AbortSignal.timeout(1500)})}catch{}
 res.json({ok:1})});
process.on('SIGINT',()=>{child&&child.kill();process.exit()});
fs.rmSync('data/healing.off',{force:true});spawnApp();setInterval(poll,1000);
app.listen(5200,()=>console.log('Dashboard on :5200'));

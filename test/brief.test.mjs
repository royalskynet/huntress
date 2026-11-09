import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { validatePlan, solve, validTx, validPost, validPreview, render, tweetCode } from '../lib/brief-plan.mjs';
import { publicAddress } from '../src/brief.mjs';
const contract='0x2728c134D79D34A977d6D35D8A3014AbB5C97ed4', selector='0x817415c4';
const hash='0x'+'a'.repeat(64), wallet='0x'+'1'.repeat(40);
const baseBrief=readFileSync(new URL('./fixtures/agent.txt',import.meta.url),'utf8')+'\n@HOPKIN\n';
const preview=() => ({success:true,data:{requestId:'request-1',simulationResult:{simulationCode:'000000000',balanceChanges:[{amount:'1'}],allowanceChanges:[],authorityChanges:[]},risks:{riskDetails:[],addresses:{[contract]:{riskLevel:0}}},requireConfirmation:false}});
function plan() { return {contract,selector,steps:[
  {id:'u',type:'get',path:'/api/unlock?wallet={wallet}'},
  {id:'a',type:'solve',expr:'{u.data.expression}'},
  {id:'t',type:'tweet',text:'@HOPKIN {u.data.tweetCode}'},
  {id:'v',type:'post',path:'/api/unlock',body:{wallet:'{wallet}',token:'{u.data.token}',answer:'{a.answer}',tweetUrl:'{t.tweetUrl}'}},
  {id:'p',type:'get',path:'/api/puzzle?wallet={wallet}&unlock={v.data.unlock}'},
  {id:'b',type:'solve',expr:'{p.data.expression}'},
  {id:'tx',type:'post',path:'/api/puzzle',body:{wallet:'{wallet}',token:'{p.data.token}',answer:'{b.answer}',unlock:'{v.data.unlock}'}},
],tx:'tx.data.tx'}; }
const taipei=() => new Date(Date.now()+8*3600000).toISOString().slice(0,10);
async function fixture(t,options={}) {
  const dir=mkdtempSync(join(tmpdir(),'brief-test-'));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const calls={http:[],discovery:[],post:0}; let homeRequests=0;
  const server=http.createServer(async(req,res) => {
    // 保留既有業務請求計數；新增的端點探索另行記錄。
    const discovery=req.url.startsWith('/assets/') || (req.url==='/' && homeRequests++>0);
    calls[discovery ? 'discovery' : 'http'].push(req.method+' '+req.url);
    let text=''; for await(const c of req) text+=c;
    const body=text ? JSON.parse(text) : null;
    const path=new URL(req.url,'http://localhost').pathname;
    res.setHeader('content-type','application/json');
    if(path==='/assets/missing.js') { res.statusCode=404; return res.end('{}'); }
    if(path==='/assets/large.js') return res.end('x'.repeat(512*1024+1));
    if(path==='/') { if(options.failHome) { options.failHome(origin); req.socket.destroy(); return; } if(options.brokenScripts) return res.end('<script src="http://["></script><script src="/assets/missing.js"></script><script src="/assets/large.js"></script>'); res.setHeader('content-type','text/html'); return res.end(options.noScripts ? '<html></html>' : '<script src="/assets/app.js"></script>'); }
    if(path==='/assets/app.js') return res.end(options.lazyChunk ? 'const a="assets/Docs-1.js",b="assets/Activity-2.js",c="assets/MintPage-x9.js";' : 'const endpoint="/api/unlock";');
    if(path==='/assets/MintPage-x9.js') return res.end('fetch("/api/unlock?wallet="+w)');
    if(path==='/assets/Docs-1.js' || path==='/assets/Activity-2.js') return res.end('const doc=1;');
    if(path==='/agent.txt') { res.statusCode=options.installOnly ? 404 : 200; return res.end(baseBrief+(options.briefEndpoints ? '\n/api/unlock\n' : '')); }
    if(path==='/skill/install.sh') return res.end(`touch ${join(dir,'SHOULD_NOT_EXIST')}`);
    if(path==='/api/unlock' && req.method==='GET') return res.end(JSON.stringify({success:true,data:{question:'math',expression:options.expression ?? '9 x 4',token:'token1',tweetCode:options.code ?? 'ABC123xyz'}}));
    if(req.method==='POST') calls.post++;
    if(path==='/api/unlock') {
      assert.equal(body.wallet,wallet); assert.equal(body.token,'token1'); assert.equal(body.answer,'36');
      assert.equal(body.tweetUrl,'https://x.com/huntress/status/123');
      return res.end(JSON.stringify({success:true,data:{unlock:'pass1',expiresAt:Date.now()+7200000}}));
    }
    if(path==='/api/puzzle' && req.method==='GET') {
      if(options.get500) { res.statusCode=500; return res.end('{}'); }
      assert.equal(new URL(req.url,'http://localhost').searchParams.get('unlock'),'pass1');
      return res.end(JSON.stringify({success:true,data:{expression:'6 + 7',token:'token2'}}));
    }
    if(path==='/api/puzzle') {
      assert.equal(body.answer,'13'); assert.equal(body.unlock,'pass1'); assert.equal(body.token,'token2');
      return res.end(JSON.stringify({success:true,data:{tx:{to:options.to ?? contract,value:options.value ?? '0',data:selector+'00',chainId:56}}}));
    }
    res.statusCode=404; res.end('{}');
  });
  t.after(() => server.close());
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const origin=`http://127.0.0.1:${server.address().port}`;
  const p=plan(); options.change?.(p,origin);
  const json=(name,obj) => writeFileSync(join(dir,name),JSON.stringify(obj));
  json('plan.json',p); json('tweet.json',{tweet:{text:options.tweetText ?? `free mint ${options.leadingLink ? options.leadingLink+' ' : ''}${origin}/`,id:'1'}});
  json('config.json',{dailyMax:30,perContractDaily:1,brief:{enabled:true,autoPost:options.autoPost ?? true,postsPerDay:options.postsPerDay ?? 3}});
  const pv=preview(); if(options.badPreview) delete pv.data.risks.addresses[contract].riskLevel;
  json('preview.json',pv);
  const fake=join(dir,'fake');
  writeFileSync(fake,`#!${process.execPath}\nimport fs from 'node:fs';
const args=process.argv.slice(2), dir=${JSON.stringify(dir)};
fs.appendFileSync(dir+'/commands.jsonl',JSON.stringify(args)+'\\n');
if(args[0]==='post') console.log(JSON.stringify({url:'https://x.com/huntress/status/123'}));
else if(args[0]==='wallet') console.log(JSON.stringify({data:{addresses:[{binanceChainId:'56',address:${JSON.stringify(wallet)}}]}}));
else if(args[1]==='preview') console.log(fs.readFileSync(dir+'/preview.json','utf8'));
else if(args[1]==='execute') {
  if(${JSON.stringify(options.timeout ?? false)}) setInterval(()=>{},1000);
  else console.log(JSON.stringify({success:true,data:{txHash:${JSON.stringify(hash)}}}));
}
`,{mode:0o755});
  // 副檔名 .mjs 讓 Node ESM 不依賴暫存目錄的 package.json。
  writeFileSync(join(dir,'package.json'),'{"type":"module"}');
  if(options.seen) json('brief-seen.json',{[origin]:options.seen});
  if(options.fullPosts) json(`brief-posts-${taipei()}.json`,{total:3});
  const env={...process.env,CONFIG:join(dir,'config.json'),STATE_DIR:dir,BAW_BIN:fake,TWITTER_BIN:fake,BRIEF_CMD:`cat '${join(dir,'plan.json')}'`,BRIEF_POST_WAIT_MS:'0',BRIEF_TEST_ALLOW_LOCAL:options.local===false ? '' : '1'};
  if(options.capturePrompt) env.BRIEF_CMD=`cat > '${join(dir,'prompt.txt')}'; cat '${join(dir,'plan.json')}'`;
  const commands=() => existsSync(join(dir,'commands.jsonl')) ? readFileSync(join(dir,'commands.jsonl'),'utf8').trim().split('\n').map(JSON.parse) : [];
  const run=(dry=false) => new Promise((resolveRun,reject) => {
    const child=spawn(process.execPath,[resolve('src/brief.mjs'),join(dir,'tweet.json'),...(dry ? ['--dry-run'] : [])],{env});
    let out='',err=''; child.stdout.on('data',c=>out+=c); child.stderr.on('data',c=>err+=c);
    child.on('error',reject); child.on('close',code=> { try { assert.equal(code,0,err); resolveRun(JSON.parse(out)); } catch(e) { reject(e); } });
  });
  return {dir,calls,commands,run,origin,seen:()=>JSON.parse(readFileSync(join(dir,'brief-seen.json'),'utf8'))[origin]};
}
function noSideEffects(f) { assert.equal(f.calls.post,0); assert.equal(f.commands().filter(a=>a[0]==='post').length,0); assert.equal(f.commands().filter(a=>a[1]==='execute').length,0); }

test('dry-run stops before first tweet or POST',async t=> { const f=await fixture(t); const r=await f.run(true); assert.equal(r.stage,'dry-run'); assert.ok(r.plan); noSideEffects(f); });
test('fenced JSON plan with prose still reaches dry-run',async t=> { const f=await fixture(t); const p=readFileSync(join(f.dir,'plan.json'),'utf8'); writeFileSync(join(f.dir,'plan.json'),'Here is the plan:\n```json\n'+p+'\n```\nDone.'); const r=await f.run(true); assert.equal(r.stage,'dry-run'); assert.ok(r.plan); noSideEffects(f); });
test('prose without JSON yields bad-plan',async t=> { const f=await fixture(t); writeFileSync(join(f.dir,'plan.json'),'Sorry, I cannot produce a plan for this tweet.'); assert.equal((await f.run(true)).stage,'bad-plan'); noSideEffects(f); });
test('complete HOPKIN flow mints and reserves ledger once',async t=> { const f=await fixture(t); assert.equal((await f.run()).stage,'minted'); assert.equal(f.seen().status,'done'); const l=JSON.parse(readFileSync(join(f.dir,`ledger-${taipei()}.json`),'utf8')); assert.equal(l.total,1); assert.equal(l.byContract[contract.toLowerCase()],1); assert.equal(JSON.parse(readFileSync(join(f.dir,'free-mints.jsonl'),'utf8')).txHash,hash); const n=f.calls.http.length; assert.equal((await f.run()).stage,'seen'); assert.equal(f.calls.http.length,n); });
test('absolute URL rejected before requests in plan',async t=> { const f=await fixture(t,{change:p=>p.steps[0].path='https://evil.test/a'}); assert.equal((await f.run()).stage,'bad-plan'); noSideEffects(f); assert.equal(f.calls.http.length,2); });
test('protocol relative path rejected',async t=> { const f=await fixture(t,{change:p=>p.steps[0].path='//evil.test/a'}); assert.equal((await f.run()).stage,'bad-plan'); noSideEffects(f); });
test('slash backslash path rejected',async t=> { const f=await fixture(t,{change:p=>p.steps[0].path='/\\evil.test/a'}); assert.equal((await f.run()).stage,'bad-plan'); noSideEffects(f); });
test('foreign mention rejected',async t=> { const f=await fixture(t,{change:p=>p.steps[2].text+=' @evil'}); assert.equal((await f.run()).stage,'bad-post'); noSideEffects(f); });
test('foreign URL rejected',async t=> { const f=await fixture(t,{change:p=>p.steps[2].text+=' https://evil.test'}); assert.equal((await f.run()).stage,'bad-post'); noSideEffects(f); });
test('missing prior code rejected',async t=> { const f=await fixture(t,{change:p=>p.steps[2].text='@HOPKIN hello'}); assert.equal((await f.run()).stage,'bad-post'); noSideEffects(f); });
test('unsupported arithmetic rejected before tweet',async t=> { const f=await fixture(t,{expression:'2 ^ 3'}); assert.equal((await f.run()).stage,'bad-plan'); noSideEffects(f); });
test('selector 0x rejected before step requests',async t=> { const f=await fixture(t,{change:p=>p.selector='0x'}); assert.equal((await f.run()).stage,'bad-plan'); noSideEffects(f); });
test('autoPost false refuses tweet',async t=> { const f=await fixture(t,{autoPost:false}); assert.equal((await f.run()).stage,'post-disabled'); noSideEffects(f); });
test('daily post cap refuses tweet',async t=> { const f=await fixture(t,{fullPosts:true}); assert.equal((await f.run()).stage,'post-limit'); noSideEffects(f); });
test('install shell is never executed',async t=> { const f=await fixture(t,{installOnly:true}); const r=await f.run(); assert.equal(r.stage,'cli-skill'); assert.ok(r.text); assert.equal(existsSync(join(f.dir,'SHOULD_NOT_EXIST')),false); noSideEffects(f); });
test('done origin skips all requests',async t=> { const f=await fixture(t,{seen:{status:'done'}}); assert.equal((await f.run()).stage,'seen'); assert.equal(f.calls.http.length,0); noSideEffects(f); });
test('leading social link is skipped, real origin still mints',async t=> { const f=await fixture(t,{leadingLink:'https://t.me/skill'}); assert.equal((await f.run()).stage,'minted'); });
test('social-only tweet yields no-brief, not a false cli-skill claim',async t=> { const f=await fixture(t,{tweetText:'free mint https://t.me/skill'}); const r=await f.run(); assert.equal(r.stage,'no-brief'); assert.equal(f.calls.http.length,0); noSideEffects(f); });
test('unknown origin skips all requests',async t=> { const f=await fixture(t,{seen:{status:'unknown'}}); assert.equal((await f.run()).stage,'seen'); assert.equal(f.calls.http.length,0); noSideEffects(f); });
test('failed third attempt skips all requests',async t=> { const f=await fixture(t,{seen:{status:'failed',n:3}}); assert.equal((await f.run()).stage,'seen'); assert.equal(f.calls.http.length,0); noSideEffects(f); });
test('localhost requires explicit test flag',async t=> { const f=await fixture(t,{local:false}); assert.equal((await f.run()).stage,'failed'); assert.equal(f.calls.http.length,0); noSideEffects(f); });
async function postThenRefuse(t,opts,stage) { const f=await fixture(t,opts); assert.equal((await f.run()).stage,stage); assert.equal(f.seen().status,'posted'); assert.equal(f.seen().n,1); assert.equal(f.commands().filter(a=>a[0]==='post').length,1); assert.equal((await f.run()).stage,stage); assert.equal(f.seen().n,2); assert.equal(f.commands().filter(a=>a[0]==='post').length,1); assert.equal(f.commands().filter(a=>a[1]==='execute').length,0); if(stage==='tx-mismatch') assert.equal(f.commands().filter(a=>a[1]==='preview').length,0); }
test('to mismatch after posting keeps posted and reuses tweet',async t=>postThenRefuse(t,{to:wallet},'tx-mismatch'));
test('nonzero value after posting keeps posted and reuses tweet',async t=>postThenRefuse(t,{value:'1'},'tx-mismatch'));
test('preview missing riskLevel after posting keeps posted',async t=>postThenRefuse(t,{badPreview:true},'bad-preview'));
test('execute timeout is unknown and never resent',{timeout:75000},async t=> { const f=await fixture(t,{timeout:true}); assert.equal((await f.run()).stage,'unknown'); assert.equal(f.seen().status,'unknown'); const n=f.calls.http.length; assert.equal((await f.run()).stage,'seen'); assert.equal(f.calls.http.length,n); assert.equal(f.commands().filter(a=>a[1]==='execute').length,1); });
test('plan rejects forward references, duplicate ids and excess steps',()=> { assert.equal(validatePlan(plan(),'https://example.test'),true); const p=plan(); p.steps[0].path='/a?x={v.data.unlock}'; assert.equal(validatePlan(p,'https://example.test'),false); const q=plan(); q.steps[1].id='u'; assert.equal(validatePlan(q,'https://example.test'),false); const r=plan(); r.steps.push(...r.steps); assert.equal(validatePlan(r,'https://example.test'),false); });
test('integer solver supports only exact grammar',()=> { assert.equal(solve('9 x 4'),'36'); assert.equal(solve('-2 × 3'),'-6'); assert.equal(solve('2 * 3'),'6'); assert.equal(solve('2 + 3'),'5'); assert.equal(solve('2 - 3'),'-1'); for(const expr of ['2 ^ 3','2 / 1','2+3+4','1.2 * 3','process.exit()']) assert.throws(()=>solve(expr)); });
test('https host resolving to loopback is refused before connecting',async t=> { const dir=mkdtempSync(join(tmpdir(),'brief-test-')); t.after(() => rmSync(dir,{recursive:true,force:true})); writeFileSync(join(dir,'tweet.json'),JSON.stringify({tweet:{text:'free mint https://localhost:9/',id:'1'}})); writeFileSync(join(dir,'config.json'),JSON.stringify({brief:{enabled:true,autoPost:true}})); const child=spawn(process.execPath,[resolve('src/brief.mjs'),join(dir,'tweet.json')],{env:{...process.env,CONFIG:join(dir,'config.json'),STATE_DIR:dir,BRIEF_TEST_ALLOW_LOCAL:''}}); let out=''; child.stdout.on('data',c=>out+=c); await once(child,'close'); const r=JSON.parse(out); assert.equal(r.stage,'failed'); assert.deepEqual(r.reasons,['non-public address']); });
test('public DNS address policy rejects private IPv4 and IPv6 variants',()=> { for(const a of ['127.0.0.1','10.0.0.1','192.168.1.1','172.16.0.1','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2001:db8::1','2002:7f00:1::']) assert.equal(publicAddress(a),false,a); assert.equal(publicAddress('8.8.8.8'),true); assert.equal(publicAddress('2606:4700:4700::1111'),true); });
test('preview numeric fields fail closed',()=> { assert.equal(validPreview(preview()),true); for(const bad of [null,'',true,'NaN','Infinity',{},[]]) { const p=preview(); p.data.simulationResult.balanceChanges[0].amount=bad; assert.equal(validPreview(p),false); } const p=preview(); delete p.data.risks.riskDetails; assert.equal(validPreview(p),false); });
test('tx requires brief word boundaries, selector and valid hex',()=> { const tx={to:contract,value:'0',data:selector}; const p=plan(); assert.equal(validTx(tx,p,baseBrief),true); assert.equal(validTx({...tx,data:selector+'0'},p,baseBrief),false); assert.equal(validTx(tx,p,'a'+contract+' '+selector),false); assert.equal(validTx({...tx,chainId:1},p,baseBrief),false); });
test('post validation enforces codes, mentions and length',()=> { const r={u:{data:{tweetCode:'ABC123'}}}; assert.equal(validPost('ABC123 @HOPKIN',baseBrief,'https://example.test',r),true); assert.equal(validPost('ABC123 '+ 'a'.repeat(280),baseBrief,'https://example.test',r),false); assert.equal(validPost('ABC123 @HOPKIN @HOPKIN @HOPKIN',baseBrief,'https://example.test',r),false); assert.equal(validPost('ABC123 https://example.test/a https://example.test/b',baseBrief,'https://example.test',r),false); });
test('templates reject prototype access and encode request values',()=> { assert.throws(()=>render('{a.constructor}',{a:{}},wallet)); assert.equal(render('/a?v={u.data.code}',{u:{data:{code:'a&b'}}},wallet,true),'/a?v=a%26b'); });

test('scheme-less foreign domains are rejected and same host is allowed',()=> {
  const r={u:{tweetCode:'ABC123'}}, origin='https://example.test';
  assert.equal(validPost('ABC123 evil.com/a',baseBrief,origin,r),false);
  assert.equal(validPost('ABC123 www.evil.com',baseBrief,origin,r),false);
  assert.equal(validPost('ABC123 example.test/a',baseBrief,origin,r),true);
  assert.equal(validPost('ABC123 example.test/a example.test/b',baseBrief,origin,r),false);
});
test('statusCode cannot substitute for tweetCode',()=> {
  const r={u:{statusCode:'SUCCESS',tweetCode:'ABC123'}};
  assert.equal(tweetCode(r),'ABC123');
  assert.equal(validPost('SUCCESS',baseBrief,'https://example.test',r),false);
});
test('different tweet codes reject posts; repeated identical codes remain valid',()=> {
  const r={u:{tweetCode:'ABC123'},v:{tweetCode:'DEF456'}};
  assert.equal(tweetCode(r),null);
  assert.equal(validPost('ABC123 DEF456',baseBrief,'https://example.test',r),false);
  assert.equal(tweetCode({u:{tweetCode:'ABC123'},v:{share_code:'ABC123'}}),'ABC123');
  assert.equal(tweetCode({u:{code:'ABC123',tweetCode:'bad!'}}),null);
});
test('post length uses weighted code points and fixed URL weight',()=> {
  const r={u:{tweetCode:'ABC123'}}, origin='https://example.test';
  assert.equal(validPost('ABC123'+'中'.repeat(140),baseBrief,origin,r),false);
  assert.equal(validPost('ABC123'+'中'.repeat(137),baseBrief,origin,r),true);
  assert.equal(validPost('ABC123 '+ 'a'.repeat(249)+' '+origin+'/'+ 'b'.repeat(400),baseBrief,origin,r),true);
  assert.equal(validPost('ABC123 '+ 'a'.repeat(250)+' '+origin+'/',baseBrief,origin,r),false);
});
test('plan rejects two tweet steps',()=> {
  const p=plan();
  p.steps.push({id:'secondTweet',type:'tweet',text:'ABC123'});
  assert.equal(validatePlan(p,'https://example.test'),false);
});

test('missing script endpoints and planner stop require human unlock',async t=> {
  const f=await fixture(t,{noScripts:true});
  writeFileSync(join(f.dir,'plan.json'),JSON.stringify({stop:'needs-unlock'}));
  const r=await f.run(); assert.equal(r.stage,'needs-unlock'); assert.ok(r.text);
  assert.equal(f.seen().status,'failed'); noSideEffects(f);
});
test('unknown endpoint is a bad plan',async t=> {
  const f=await fixture(t,{change:p=>p.steps[0].path='/api/other'});
  assert.equal((await f.run()).stage,'bad-plan'); noSideEffects(f);
});
test('GET failure after posting retains tweet and retries without reposting',async t=> {
  const f=await fixture(t,{get500:true});
  assert.equal((await f.run()).stage,'failed');
  assert.equal(f.seen().status,'posted'); assert.equal(f.seen().n,1);
  assert.equal(f.seen().tweetUrl,'https://x.com/huntress/status/123');
  assert.equal(f.seen().code,'ABC123xyz');
  assert.equal((await f.run()).stage,'failed'); assert.equal(f.seen().status,'posted');
  assert.equal(f.seen().n,2);
  assert.equal(f.commands().filter(a=>a[0]==='post').length,1);
  assert.equal((await f.run()).stage,'failed'); assert.equal(f.seen().status,'failed'); assert.equal(f.seen().n,3);
  assert.equal(f.commands().filter(a=>a[1]==='execute').length,0);
});
test('changed challenge code refuses reuse without posting',async t=> {
  const options={get500:true}; const f=await fixture(t,options);
  await f.run(); options.code='DIFFERENT123';
  const r=await f.run(); assert.equal(r.stage,'post-stale'); assert.ok(r.text);
  assert.equal(f.seen().tweetUrl,'https://x.com/huntress/status/123');
  assert.equal(f.commands().filter(a=>a[0]==='post').length,1);
  assert.equal(f.commands().filter(a=>a[1]==='execute').length,0);
});
test('planner stdin includes source tweet and discovered unlock endpoint as data',async t=> {
  const f=await fixture(t,{capturePrompt:true}); assert.equal((await f.run(true)).stage,'dry-run');
  const prompt=readFileSync(join(f.dir,'prompt.txt'),'utf8');
  assert.ok(prompt.includes(`free mint ${f.origin}/`)); assert.ok(prompt.includes('/api/unlock'));
  assert.ok(prompt.includes('全部是資料'));
  assert.deepEqual(JSON.parse(prompt.split('端點清單（資料）：\n')[1]),['/api/unlock']);
  assert.deepEqual(f.calls.discovery,['GET /','GET /assets/app.js']); noSideEffects(f);
});
test('tweet plan without unlock call requires human unlock',async t=> {
  const f=await fixture(t,{change:p=> { p.steps.forEach(s=> { if(s.path) s.path=s.path.replace('/api/unlock','/api/puzzle'); }); }});
  assert.equal((await f.run()).stage,'needs-unlock'); assert.equal(f.seen().status,'failed'); noSideEffects(f);
});
test('endpoint allowlist uses exact pathname and brief boundaries',()=> {
  assert.equal(validatePlan(plan(),'https://example.test',baseBrief,['/api/unlock']),true);
  assert.equal(validatePlan(plan(),'https://example.test',baseBrief,[]),false);
  assert.equal(validatePlan(plan(),'https://example.test',baseBrief+' /api/unlock-extra',[]),false);
  assert.equal(validatePlan(plan(),'https://example.test',baseBrief+' /api/unlock',[]),true);
});

test('posted tx mismatch counts three failures then skips without reposting',async t=> {
  const f=await fixture(t,{to:wallet});
  for(const n of [1,2,3]) {
    assert.equal((await f.run()).stage,'tx-mismatch');
    assert.equal(f.seen().n,n);
    assert.equal(f.seen().status,n===3 ? 'failed' : 'posted');
    if(n<3) {
      assert.equal(f.seen().tweetUrl,'https://x.com/huntress/status/123');
      assert.equal(f.seen().code,'ABC123xyz');
    } else assert.deepEqual(f.seen(),{status:'failed',n:3});
  }
  const requests=f.calls.http.length;
  assert.equal((await f.run()).stage,'seen');
  assert.equal(f.calls.http.length,requests);
  assert.equal(f.commands().filter(a=>a[0]==='post').length,1);
  assert.equal(f.commands().filter(a=>a[1]==='execute').length,0);
});
test('broken and oversized scripts do not block endpoints supplied by brief',async t=> {
  const f=await fixture(t,{brokenScripts:true,briefEndpoints:true,capturePrompt:true});
  assert.equal((await f.run(true)).stage,'dry-run');
  assert.deepEqual(f.calls.discovery,['GET /','GET /assets/missing.js','GET /assets/large.js']);
  const prompt=readFileSync(join(f.dir,'prompt.txt'),'utf8');
  assert.deepEqual(JSON.parse(prompt.split('端點清單（資料）：\n')[1]),[]);
  noSideEffects(f);
});
test('scheme-less Chinese foreign domain is rejected',()=> {
  assert.equal(validPost('ABC123 例子.com',baseBrief,'https://example.test',{u:{tweetCode:'ABC123'}}),false);
});
test('scheme-less accented foreign domain is rejected',()=> {
  assert.equal(validPost('ABC123 münchen.de/x',baseBrief,'https://example.test',{u:{tweetCode:'ABC123'}}),false);
});
test('international domains normalize hosts and retain URL count and weight',()=> {
  const r={u:{tweetCode:'ABC123'}}, origin='https://xn--mnchen-3ya.de';
  assert.equal(validPost('ABC123',baseBrief,origin,r),true);
  assert.equal(validPost('ABC123 münchen.de/x',baseBrief,origin,r),true);
  assert.equal(validPost('ABC123 münchen.de/x münchen.de/y',baseBrief,origin,r),false);
  assert.equal(validPost('ABC123 '+'a'.repeat(249)+' münchen.de/'+'中'.repeat(400),baseBrief,origin,r),true);
  assert.equal(validPost('ABC123 '+'a'.repeat(250)+' münchen.de/',baseBrief,origin,r),false);
});

test('Punycode foreign top-level domain is rejected',()=> {
  assert.equal(validPost('ABC123 evil.xn--p1ai',baseBrief,'https://example.test',{u:{tweetCode:'ABC123'}}),false);
});

test('catch returns within eight seconds while ledger port stays occupied', {timeout:10000}, async t=> {
  const options={};
  const f=await fixture(t,options);
  const moduleURL=new URL('../lib/ledger.mjs',import.meta.url).href;
  const owner=spawn(process.execPath,['--input-type=module','-e',`
    import { withLedgerLock } from ${JSON.stringify(moduleURL)};
    await withLedgerLock(${JSON.stringify(f.dir)}, async () => {
      console.log('held'); await new Promise(resolve => setTimeout(resolve,20000));
    });`]);
  t.after(()=>owner.kill('SIGKILL'));
  const closed=once(owner,'close');
  await once(owner.stdout,'data');
  // 入口讀取後才寫入 posting 並中斷連線，確保經過 catch。
  try {
    const entries={[f.origin]:{status:'posting'}};
    options.failHome=()=>writeFileSync(join(f.dir,'brief-seen.json'),JSON.stringify(entries));
    const start=Date.now();
    const result=await f.run();
    assert.ok(Date.now()-start<8000);
    assert.equal(result.stage,'unknown');
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir,'brief-seen.json'),'utf8')),entries);
    noSideEffects(f);
  } finally { owner.kill('SIGKILL'); await closed; }
});

test('unlock endpoint inside a lazy mint chunk is discovered',async t=> {
  const f=await fixture(t,{capturePrompt:true,lazyChunk:true}); assert.equal((await f.run(true)).stage,'dry-run');
  const prompt=readFileSync(join(f.dir,'prompt.txt'),'utf8');
  assert.deepEqual(JSON.parse(prompt.split('端點清單（資料）：\n')[1]),['/api/unlock']);
  assert.equal(f.calls.discovery[2],'GET /assets/MintPage-x9.js'); noSideEffects(f);
});

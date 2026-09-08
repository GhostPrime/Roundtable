// scripts/check-poll.js
// Smoke test for runPoll — the poll's whole contract is that no seat sees
// another seat's answer, so that is asserted directly (by planting a unique
// marker in each reply and searching every other seat's payload for it),
// alongside progressive landing, per-seat call ids, prompt shape, and the
// failure/abort paths.
//
// Run:  node --experimental-default-type=module scripts/check-poll.js
import { runPoll, POLL_FOLLOWUP, buildMessagesFor } from '../src/orchestrator.js';
import { buildPromptStages, assemblePrompt } from '../src/promptStages.js';

const t=[]; const ok=(n,c)=>t.push([c?'PASS':'FAIL',n]);
const seats=[
  {id:'a',name:'Qwen',provider:'ollama',role:'coder',canWrite:true,color:'#a1c'},
  {id:'b',name:'Claude',provider:'cli',role:'reviewer',canWrite:true},
  {id:'c',name:'GPT',provider:'openai',role:'subtractor'},
];
const base=[{speaker:'You',agentId:null,text:'Should we rewrite the sync layer?'}];

// --- 1. isolation: no seat's messages contain another seat's answer ---------
const seen={};
let r = await runPoll({
  agents:seats, transcript:base, mode:'build', shouldStop:()=>false,
  callAgent: async (ag,msgs,i)=>{
    seen[ag.name]=JSON.stringify(msgs);
    // stagger completion so order is scrambled on purpose
    await new Promise(z=>setTimeout(z,[30,5,15][i]));
    return `ANSWER_FROM_${ag.name}`;
  },
  onReply:()=>{},
});
ok('every seat answered', r.entries.length===3);
const leak = Object.entries(seen).some(([who,payload]) =>
  ['Qwen','Claude','GPT'].filter(n=>n!==who).some(n=>payload.includes(`ANSWER_FROM_${n}`)));
ok('ISOLATION: no seat saw another seat answer', !leak);
ok('returned entries sorted by seat order',
   r.entries.map(e=>e.speaker).join(',')==='Qwen,Claude,GPT');
ok('entries tagged with one shared pollId', new Set(r.entries.map(e=>e.pollId)).size===1);
ok('pollIndex matches seat order', r.entries.every((e,i)=>e.pollIndex===i));
ok('pollTotal set', r.entries.every(e=>e.pollTotal===3));

// --- 2. progressive landing: onReply fires in COMPLETION order --------------
const landed=[];
await runPoll({
  agents:seats, transcript:base, mode:'build', shouldStop:()=>false,
  callAgent: async (ag,msgs,i)=>{ await new Promise(z=>setTimeout(z,[40,5,20][i])); return 'x'; },
  onReply:(e)=>landed.push(e.speaker),
});
ok('landed progressively, fastest first', landed.join(',')==='Claude,GPT,Qwen');

// --- 3. distinct callId per seat -------------------------------------------
const ids=[];
await runPoll({
  agents:seats, transcript:base, shouldStop:()=>false,
  callAgent: async (ag,msgs,i)=>{ ids.push(`call_X:p${i}`); return 'x'; },
  onReply:()=>{},
});
ok('caller can mint a distinct id per seat', new Set(ids).size===3);

// --- 4. prompt: poll stage present, tools suppressed -----------------------
let built=null;
await runPoll({
  agents:[seats[0]], transcript:base, mode:'build', shouldStop:()=>false,
  callAgent: async (ag)=>{ built=ag.systemPrompt; return 'x'; }, onReply:()=>{},
});
ok('POLL note injected', /THIS TURN IS A POLL/.test(built));
ok('poll note is the LAST block', built.trim().endsWith('Just your\nanswer.'));
ok('no CHECK syntax on a poll', !/CHECK: write_file/.test(built));
ok('no web tool on a poll', !/web_search/.test(built));
ok('no task board on a poll', !/TASK: add/.test(built));
ok('mode block still present', /MODE: BUILD/.test(built));
ok('role directive still present', /CODER/.test(built));

// build mode WITHOUT poll still has everything
const normal = assemblePrompt(buildPromptStages(seats[0],'build',{}));
ok('non-poll build prompt unchanged (has CHECK)', /CHECK: write_file/.test(normal));
ok('non-poll build prompt unchanged (has TASK)', /TASK: add/.test(normal));
ok('non-poll build prompt has no poll note', !/THIS TURN IS A POLL/.test(normal));

// --- 5. stop mid-poll -------------------------------------------------------
let stopped=false;
const rs = await runPoll({
  agents:seats, transcript:base, shouldStop:()=>stopped, 
  callAgent: async ()=>{ stopped=true; return '__ABORTED__'; }, onReply:()=>{},
});
ok('abort sentinel yields no entries', rs.entries.length===0);

// --- 6. one seat failing does not kill the poll ----------------------------
const rf = await runPoll({
  agents:seats, transcript:base, shouldStop:()=>false,
  callAgent: async (ag)=>{ if(ag.name==='Claude') throw new Error('CLI timeout'); return 'fine'; },
  onReply:()=>{},
});
ok('failed seat does not abort the others', rf.entries.length===3);
ok('failed seat is flagged', rf.entries.find(e=>e.speaker==='Claude').pollFailed===true);
ok('failure text is the error', /CLI timeout/.test(rf.entries.find(e=>e.speaker==='Claude').text));

// --- 7. no task board line in the messages ---------------------------------
let msgsSeen=null;
await runPoll({agents:[seats[0]],transcript:base,shouldStop:()=>false,
  callAgent:async(ag,m)=>{msgsSeen=m;return 'x';},onReply:()=>{}});
const withBoard = buildMessagesFor(seats[0], base, 'BOARD: #1 do a thing');
ok('poll messages carry no task board', !JSON.stringify(msgsSeen).includes('BOARD:'));
ok('(control) buildMessagesFor does append a board', JSON.stringify(withBoard).includes('BOARD:'));

// --- 8. empty roster --------------------------------------------------------
const re = await runPoll({agents:[],transcript:base,shouldStop:()=>false,callAgent:async()=>'x',onReply:()=>{}});
ok('empty roster is a no-op', re.entries.length===0 && Array.isArray(re.working));
ok('follow-up prompt exists and asks for the split', /disagree/.test(POLL_FOLLOWUP));

for(const [r,n] of t) console.log(`${r}  ${n}`);
const f=t.filter(x=>x[0]==='FAIL').length;
console.log(`\n${t.length-f}/${t.length} passed`);
process.exit(f?1:0);

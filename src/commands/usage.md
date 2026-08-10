---
description: Show the ChatGPT quota spent on runs delegated to Codex — by day, project and agent
allowed-tools: Bash
---

<!-- Part of the agents/codex-bridge/ package. The file lives here out of necessity: the slash
     command name is set by its location under commands/<namespace>/, and Claude Code understands neither
     symlinks nor pointer files (verified 2026-08-02). Edit it here; it travels as a copy when the
     package is installed. -->

Count how much ChatGPT quota the runs delegated to Codex burned. This is spending on the Codex side,
not on the Claude side.

The root of the run folders comes from `CODEX_RUNS_ROOT` when it is set, otherwise from
`~/.claude/codex-runs` — the same order the runner itself uses, because otherwise the accounting
would stop seeing runs whenever the root is overridden.

The source is the `meta.json` in each run folder: it holds the spending, the model and the sandbox.
Transport files are not kept in git and may be deleted, so parsing them is not allowed — the
accounting has to survive a transcript cleanup. Runs from before `meta.json` existed keep a
fallback parser for the `raw.log` those folders still contain; current runs no longer write that
file, and their spending comes from the CLI's own `turn.completed` events.

`codex exec review` prints no spending at all, so such runs land in the "unaccounted" line. Counting
them as zero is not allowed — that would silently understate the total.

A project folder is marked by a `.project.json` file holding the repository path. Two different
repositories with the same directory name get `api` and `api-2`, so the repository path is printed
under the project line — but only when the folder name and the repository directory name have
diverged. Otherwise the `api-2` line in a spending report would not say whose spending it is.

Run exactly this command and recompute nothing by hand:

```bash
node -e "
const fs=require('fs'),path=require('path');
const root=(process.env.CODEX_RUNS_ROOT||'').trim()||path.join(process.env.USERPROFILE||process.env.HOME,'.claude','codex-runs');
if(!fs.existsSync(root)){console.log('No runs yet.');process.exit(0)}
const runs=[],unknown=[];
for(const proj of fs.readdirSync(root)){
  const pdir=path.join(root,proj);
  if(!fs.statSync(pdir).isDirectory())continue;
  let repo=null;
  try{repo=JSON.parse(fs.readFileSync(path.join(pdir,'.project.json'),'utf8')).repo||null}catch{}
  for(const run of fs.readdirSync(pdir)){
    const dir=path.join(pdir,run),meta=path.join(dir,'meta.json'),log=path.join(dir,'raw.log');
    let tokens=null,agent=null,sandbox=null;
    if(fs.existsSync(meta)){
      try{const m=JSON.parse(fs.readFileSync(meta,'utf8'));tokens=m.tokens??null;agent=m.agent||null;sandbox=m.sandbox||null}catch{}
    } else if(fs.existsSync(log)){
      const hit=[...fs.readFileSync(log,'utf8').matchAll(/tokens used[\r\n]+([^\r\n]+)/g)].pop();
      tokens=hit?parseInt(hit[1].replace(/\D/g,''),10)||null:null;
    } else continue;
    const entry={proj,repo,run,day:run.slice(0,10),agent:agent||(/review/.test(run)?'codex-review':/build/.test(run)?'codex-build':'codex-scout'),sandbox};
    if(tokens===null){unknown.push(entry);continue}
    runs.push({...entry,tokens});
  }
}
if(!runs.length&&!unknown.length){console.log('No runs yet.');process.exit(0)}
const sum=a=>a.reduce((s,r)=>s+r.tokens,0);
const group=k=>{const m={};runs.forEach(r=>{(m[r[k]]=m[r[k]]||[]).push(r)});return m};
const fmt=n=>n.toLocaleString('en-US');
const row=(l,rs)=>'  '+String(l).padEnd(22)+String(rs.length).padStart(3)+' runs  '+fmt(sum(rs)).padStart(11)+'  average '+fmt(Math.round(sum(rs)/rs.length));
if(runs.length)console.log('TOTAL: '+fmt(sum(runs))+' tokens over '+runs.length+' runs · average '+fmt(Math.round(sum(runs)/runs.length)));
if(unknown.length)console.log('Unaccounted: '+unknown.length+' runs (Codex reported no spending) — the total is understated');
const risky=[...runs,...unknown].filter(r=>r.sandbox&&r.sandbox!=='read-only'&&r.sandbox!=='workspace-write');
if(risky.length)console.log('WARNING: '+risky.length+' runs went outside the usual sandbox: '+risky.map(r=>r.run+' ('+r.sandbox+')').join(', '));
if(runs.length){
  console.log('');console.log('By day:');
  Object.entries(group('day')).sort().forEach(([d,rs])=>console.log(row(d,rs)));
  console.log('');console.log('By project:');
  Object.entries(group('proj')).sort((a,b)=>sum(b[1])-sum(a[1])).forEach(([p,rs])=>{
    console.log(row(p,rs));
    const repo=rs.find(r=>r.repo)?.repo;
    if(repo&&path.basename(repo)!==p)console.log('      '+repo);
  });
  console.log('');console.log('By agent:');
  Object.entries(group('agent')).sort((a,b)=>sum(b[1])-sum(a[1])).forEach(([k,rs])=>console.log(row(k,rs)));
  console.log('');console.log('Most expensive runs:');
  runs.sort((a,b)=>b.tokens-a.tokens).slice(0,5).forEach(r=>console.log('  '+fmt(r.tokens).padStart(11)+'  '+r.proj+'/'+r.run));
}
"
```

Print the result as is, without retelling it. Add exactly one line of your own: whether the current
pace fits inside the subscription window or the spending is growing fast.

If the `WARNING` line about the sandbox showed up — work out why the run went outside `read-only` or
`workspace-write`, and say so separately: it is a sign that the agent deviated from its command.

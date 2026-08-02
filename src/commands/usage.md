---
description: Показать расход квоты ChatGPT на делегированные в Codex прогоны — по дням, проектам и агентам
allowed-tools: Bash
---

<!-- Часть пакета agents/codex/. Файл лежит здесь вынужденно: имя слэш-команды задаётся
     расположением в commands/<namespace>/, а симлинков и файлов-указателей Claude Code не
     понимает (проверено 2026-08-02). Правится здесь же; при выносе пакета едет копией. -->

Посчитай, сколько квоты ChatGPT сожгли делегированные в Codex прогоны. Это расход на стороне
Codex, не на стороне Claude.

Корень папок прогона берётся из `CODEX_RUNS_ROOT`, если он задан, иначе `~/.claude/codex-runs` —
тот же порядок, что у самого раннера, иначе учёт перестал бы видеть прогоны при переопределённом
корне.

Источник — `meta.json` в папке каждого прогона: там расход, модель и песочница. Сам `raw.log`
в git не хранится и может быть удалён, поэтому парсить его нельзя — учёт должен переживать
чистку транскриптов. Для старых прогонов без `meta.json` есть запасной разбор лога.

`codex exec review` расход не печатает вовсе, поэтому такие прогоны попадают в строку
«без учёта». Считать их нулём нельзя — это молча занизило бы итог.

Папка проекта помечена файлом `.project.json` с путём репозитория. Два разных репозитория с
одинаковым именем каталога получают `api` и `api-2`, поэтому под строкой проекта печатается путь
репозитория — но только когда имя папки и имя каталога репозитория разошлись. Иначе строка
`api-2` в отчёте о расходе не сказала бы, чей это расход.

Выполни ровно эту команду и ничего не пересчитывай руками:

```bash
node -e "
const fs=require('fs'),path=require('path');
const root=(process.env.CODEX_RUNS_ROOT||'').trim()||path.join(process.env.USERPROFILE||process.env.HOME,'.claude','codex-runs');
if(!fs.existsSync(root)){console.log('Прогонов ещё не было.');process.exit(0)}
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
if(!runs.length&&!unknown.length){console.log('Прогонов ещё не было.');process.exit(0)}
const sum=a=>a.reduce((s,r)=>s+r.tokens,0);
const group=k=>{const m={};runs.forEach(r=>{(m[r[k]]=m[r[k]]||[]).push(r)});return m};
const fmt=n=>n.toLocaleString('ru-RU');
const row=(l,rs)=>'  '+String(l).padEnd(22)+String(rs.length).padStart(3)+' прогонов  '+fmt(sum(rs)).padStart(11)+'  среднее '+fmt(Math.round(sum(rs)/rs.length));
if(runs.length)console.log('ВСЕГО: '+fmt(sum(runs))+' токенов за '+runs.length+' прогонов · среднее '+fmt(Math.round(sum(runs)/runs.length)));
if(unknown.length)console.log('Без учёта: '+unknown.length+' прогонов (Codex не сообщил расход) — итог занижен');
const risky=[...runs,...unknown].filter(r=>r.sandbox&&r.sandbox!=='read-only'&&r.sandbox!=='workspace-write');
if(risky.length)console.log('ВНИМАНИЕ: '+risky.length+' прогонов шли вне обычной песочницы: '+risky.map(r=>r.run+' ('+r.sandbox+')').join(', '));
if(runs.length){
  console.log('');console.log('По дням:');
  Object.entries(group('day')).sort().forEach(([d,rs])=>console.log(row(d,rs)));
  console.log('');console.log('По проектам:');
  Object.entries(group('proj')).sort((a,b)=>sum(b[1])-sum(a[1])).forEach(([p,rs])=>{
    console.log(row(p,rs));
    const repo=rs.find(r=>r.repo)?.repo;
    if(repo&&path.basename(repo)!==p)console.log('      '+repo);
  });
  console.log('');console.log('По агентам:');
  Object.entries(group('agent')).sort((a,b)=>sum(b[1])-sum(a[1])).forEach(([k,rs])=>console.log(row(k,rs)));
  console.log('');console.log('Самые дорогие прогоны:');
  runs.sort((a,b)=>b.tokens-a.tokens).slice(0,5).forEach(r=>console.log('  '+fmt(r.tokens).padStart(11)+'  '+r.proj+'/'+r.run));
}
"
```

Выведи результат как есть, без пересказа. Добавь от себя ровно одну строку: укладывается ли
текущий темп в окно подписки или расход растёт быстро.

Если вывелась строка «ВНИМАНИЕ» про песочницу — разберись, почему прогон шёл вне read-only или
workspace-write, и скажи об этом отдельно: это признак того, что агент отклонился от своей команды.

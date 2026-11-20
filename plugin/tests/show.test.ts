import { expect, test } from 'claude-code/testing'

import { answerText, blueprintName, collectAnswers, isBlueprintFile, viewError, viewOwner, present, isViewOpen, refreshSources, toggleView } from '../hooks/show'
import { SHOW_CASES } from './fixtures/show-cases'

const HOME = '/home/me'

test('each shared case gets the answer cockpit mcp is held to as well', async () => {
  for (const c of SHOW_CASES) expect([c.name, viewError(c.spec) ?? null]).toEqual([c.name, c.error])
})
const DIR = `${HOME}/.cache/cockpit/show`
const ran = (exitCode: number, stdout = '') => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

test('a compare block shows in a pane as well as in the browser', async () => {
  const blocks = [{ type: 'compare', before: '/tmp/before.png', after: 'https://example.com/after.png' }]
  expect(viewError({ pane: 'header', title: 'Header', blocks })).toBe(undefined)
  expect(viewError({ pane: 'header', title: 'Header', placement: 'browser', blocks })).toBe(undefined)
  expect(viewError({ pane: 'header', title: 'Header', blocks: [{ type: 'compare', before: 'before.png', after: '/a.png' }] })).toContain('absolute path')
})

test('a diff line comment reads as the person speaking', async () => {
  const comment = { block: 0, type: 'comment', value: { path: 'src/quota.rs', line: 3, text: 'keep 100 for pro' }, label: 'src/quota.rs:3' }
  expect(answerText('quota', comment, { type: 'diff' })).toBe('In the quota pane I commented on src/quota.rs:3: keep 100 for pro')
  const pick = { block: 1, type: 'choice', value: 'free', label: 'Free' }
  expect(answerText('quota', pick, { type: 'choice', prompt: 'Which plan?' })).toBe('In the quota pane I picked "Free" for: Which plan.')
  const review = { block: 0, type: 'review', value: { comments: [] }, label: '1) src/quota.rs:3: keep 100 2) src/plan.rs:9: rename' }
  expect(answerText('quota', review, { type: 'diff' })).toBe('In the quota pane I commented on the diff: 1) src/quota.rs:3: keep 100 2) src/plan.rs:9: rename')
})

test('each comment reaches the session and leaves the diff as it was', async () => {
  const spec = { title: 'Diff', at: Date.now(), session: 's1', blocks: [{ type: 'diff', patch: 'diff --git a/x b/x' }] }
  const files = new Map<string, string>([[`${DIR}/quota.json`, JSON.stringify(spec)]])
  const comment = (line: number, text: string) => JSON.stringify({ block: 0, type: 'comment', value: { path: 'x', line, text }, label: `x:${line}`, at: line })
  const written: string[] = []
  const said: string[] = []
  // Just what collectAnswers reaches for: files, rm, and the prompt.
  const fake = {
    env: { get: async (name: string) => (name === 'HOME' ? HOME : undefined) },
    fs: {
      read: async (path: string) => {
        const content = files.get(path)
        if (content === undefined) throw new Error('ENOENT')
        return content
      },
      write: async (path: string) => void written.push(path),
      list: async () => [...files.keys()].map(path => ({ name: path.slice(DIR.length + 1), kind: 'file', size: 1, mtimeMs: 1, isLink: false })),
    },
    process: {
      run: async (argv: string[]) => {
        if (argv[0] === 'rm') files.delete(argv[2]!)
        return ran(0)
      },
    },
    prompt: { submit: async ({ text }: { text: string }) => void said.push(text) },
  } as unknown as Parameters<typeof collectAnswers>[0]

  files.set(`${DIR}/quota.0.answer`, comment(1, 'first'))
  await collectAnswers(fake, 's1')
  files.set(`${DIR}/quota.0.answer`, comment(2, 'second'))
  await collectAnswers(fake, 's1')

  expect(said).toEqual(['In the quota pane I commented on x:1: first', 'In the quota pane I commented on x:2: second'])
  expect(written.filter(p => p.endsWith('quota.json'))).toEqual([])
  expect(files.has(`${DIR}/quota.0.answer`)).toBe(false)
})

test('a blueprint is one Mermaid flowchart per view, named after its session', async () => {
  const plan = { type: 'blueprint', text: '---\ntitle: Quota limits\n---\nflowchart TD\n  A[Read limits] --> B[Count calls]\n  class A done' }
  expect(viewError({ pane: 'blueprint', title: 'Plan', blocks: [plan] })).toBe(undefined)
  expect(viewError({ pane: 'blueprint', title: 'Plan', blocks: [{ type: 'blueprint', text: 'sequenceDiagram\n A->>B: hi' }] })).toContain('flowchart')
  expect(viewError({ pane: 'blueprint', title: 'Plan', blocks: [plan, plan] })).toContain('one blueprint')
  expect(viewError({ pane: 'blueprint', title: 'Plan', placement: 'browser', blocks: [plan] })).toContain('in a pane')
  expect(blueprintName('blueprint', '3F2A1C9D-0000-4000-8000-000000000000')).toBe('blueprint-3f2a1c9d')
  const fake = { env: { get: async (name: string) => (name === 'HOME' ? HOME : undefined) } } as unknown as Parameters<typeof isBlueprintFile>[0]
  expect(await isBlueprintFile(fake, `${DIR}/blueprint-3f2a1c9d.mmd`)).toBe(true)
  expect(await isBlueprintFile(fake, `${DIR}/../config.mmd`)).toBe(false)
  expect(await isBlueprintFile(fake, `${HOME}/repo/plan.mmd`)).toBe(false)
})

test('a click on a blueprint box reads as a change request about it', async () => {
  const ask = { block: 0, type: 'blueprint', value: { node: 'B', label: 'Count calls', text: 'count per org, not per user' }, label: 'Count calls' }
  expect(answerText('blueprint-3f2a1c9d', ask, { type: 'blueprint' })).toBe('In the blueprint, about «Count calls» (box B): count per org, not per user')
})


function presentation(windowCode = 0) {
  const files = new Map<string,string>([[`${HOME}/.config/cockpit/herdr/cockpit.sh`, ''],[`${HOME}/.config/cockpit/herdr/app.sh`,''],[`${HOME}/.config/cockpit/config.json`,JSON.stringify({herdrPluginRoot:`${HOME}/.config/cockpit/herdr`})]]);
  const calls:string[][]=[];
  const $={
    env:{get:async (key:string)=>({HOME,HC_TERMINAL_ID:'t14'} as Record<string,string>)[key]},
    session:{id:async()=> 'acme-session',cwd:async()=>'/src/acme/api'},
    fs:{read:async(path:string)=>{if(!files.has(path)) throw Error('ENOENT'); return files.get(path)!},
      write:async(path:string,text:string)=>void files.set(path,text),
      stat:async(path:string)=>{if(!files.has(path)) throw Error('ENOENT');return {mtimeMs:1,size:1}},
      list:async()=>[]},
    process:{run:async(argv:string[])=>{
      calls.push(argv);
      if(argv.join(' ').includes('command -v')) return ran(1);
      if(argv.includes('browse') || argv.some(a=>a.endsWith('/browse.sh'))) return ran(3);
      if(argv[0]==='herdr'&&argv[2]==='split') return ran(0,'{"result":{"pane":{"pane_id":"w1:p2"}}}');
      if(argv.includes('window')) return {...ran(windowCode,argv.includes('pane.split')?'{"pane":"p9"}':argv.at(-1)==='ls'?JSON.stringify({spaces:[{id:'s1',tabs:[{id:'tab1',terminals:[{terminal:'t14',pane:'p14'}]}]}]}):'{}'),stderr:windowCode?'no Herdr window is connected to this machine':''};
      return ran(0,'{}');
    }},
  } as unknown as Parameters<typeof present>[0];
  return {$,files,calls};
}

test('a page that did not open says so',async()=>{
  const f=presentation();
  const answer=await present(f.$,'quota',{title:'Quota',blocks:[{type:'text',text:'ENG-412'}],at:1,session:'acme-session',placement:'browser'},undefined);
  expect('result' in answer && answer.result).toContain('no browser opened');
});

test('show without a window says it wrote the view',async()=>{
  const f=presentation(3);
  const answer=await present(f.$,'quota',{title:'Quota',blocks:[{type:'text',text:'ENG-412'}],at:1,session:'acme-session'},undefined);
  expect('result' in answer && answer.result).toContain('No Herdr window is connected');
  expect(f.files.has(`${DIR}/quota.json`)).toBe(true);
});

const appHere = {pane:'app:t14',tab:'tab1',space:'s1',frontend:'app' as const,terminal:'t14',paneId:'p14'}
const quotaSpec = {title:'Quota',blocks:[{type:'markdown',text:'ENG-412'}],at:1,session:'acme-session'}
test('a new view tells the window instead of taking the person to the session',async()=>{
 const f=presentation();const answer=await present(f.$,'new-quota',quotaSpec,appHere)
 expect('result' in answer && answer.result).toBe('Put new-quota in Documents beside this session.')
 expect(f.calls.filter(a=>a.includes('do')).map(a=>a[a.indexOf('do')+1])).toEqual(['cockpit.doc-shown:t14:new-quota|Quota'])
})
test('an update only rewrites the view',async()=>{
 const f=presentation();await present(f.$,'existing-quota',quotaSpec,appHere);const count=f.calls.filter(a=>a.includes('do')).length
 const answer=await present(f.$,'existing-quota',quotaSpec,appHere)
 expect('result' in answer && answer.result).toBe('Updated existing-quota in Documents.');expect(f.calls.filter(a=>a.includes('do')).length).toBe(count)
})
test('down still splits a pane',async()=>{
 const f=presentation();await present(f.$,'down-quota',{...quotaSpec,placement:'down'},appHere)
 expect(f.calls.some(a=>a.includes('pane.split'))).toBe(true)
})
test('a browser view with no browser lands in Documents',async()=>{
 const f=presentation();const answer=await present(f.$,'browser-quota',{...quotaSpec,placement:'browser'},appHere)
 expect('result' in answer && answer.result).toBe('No browser beside this session: browser-quota is in Documents instead.')
 expect(JSON.parse(f.files.get(`${DIR}/browser-quota.json`)!).placement).toBe(undefined)
 expect(f.calls.some(a=>a.includes('cockpit.doc-shown:t14:browser-quota|Quota'))).toBe(true)
})
test('a blueprint goes to Documents too',async()=>{
 const f=presentation();await present(f.$,'blueprint-acme',{...quotaSpec,blocks:[{type:'blueprint',text:'flowchart TD\n a --> b'}]},appHere)
 expect(f.calls.some(a=>a.includes('cockpit.doc-shown:t14:blueprint-acme|Quota'))).toBe(true)
})
test('the herdr TUI still splits a pane',async()=>{
 const f=presentation();await present(f.$,'tui-quota',quotaSpec,{pane:'w1:p1',tab:'t1',space:'w1',frontend:'tui'})
 expect(f.calls.some(a=>a[0]==='herdr'&&a[2]==='split')).toBe(true)
})

test('Documents are live to source refresh and footer navigation without split markers',async()=>{
 const f=presentation(),name='live-quota',at=Date.now();
 f.$.session.id=async()=> 'acme-live';
 f.files.set(`${DIR}/${name}.json`,JSON.stringify({...quotaSpec,at,session:'acme-live',terminal:'t14',blocks:[{type:'table',source:{metabase:{question:412}},columns:['old'],rows:[],refreshed_at:0}]}));
 f.$.fs.list=async()=>[{name:`${name}.json`,kind:'file',size:1,mtimeMs:at,isLink:false}];
 const original=f.$.process.run;
 f.$.process.run=async (argv,options)=>argv.includes('shown') ? ran(0,JSON.stringify([{terminal:'t14',name}])) : original(argv,options);
 f.$.mcp={call:async()=>({isError:false,content:[{type:'text',text:JSON.stringify({cols:[{name:'count'}],rows:[[42]]})}]})} as typeof f.$.mcp;
 expect(await isViewOpen(f.$,name)).toBe(true);
 await refreshSources(f.$,'acme-live');
 expect(JSON.parse(f.files.get(`${DIR}/${name}.json`)!).blocks[0].rows).toEqual([[42]]);
 await toggleView(f.$,name,appHere);
 expect(f.calls.some(a=>a.includes(`cockpit.panel-open:show:${name}`))).toBe(true);
 expect(f.calls.some(a=>a.includes('pane.split'))).toBe(false);
});

test('repeated show with no window reports storage without claiming Documents presentation',async()=>{
 for(const placement of [undefined,'browser'] as const) {
  const f=presentation(3),name=placement?'offline-browser':'offline-quota',spec={...quotaSpec,placement};
  for(let n=0;n<2;n++) {
   const answer=await present(f.$,name,spec,undefined);
   expect('result' in answer && answer.result).toContain('No Herdr window is connected');
   expect('result' in answer && answer.result.includes('is in Documents instead')).toBe(false);
   expect('result' in answer && answer.result.includes('Updated ')).toBe(false);
  }
  expect(f.files.has(`${DIR}/${name}.json`)).toBe(true);
  expect(f.calls.some(a=>a.includes('do'))).toBe(false);
 }
});

test('an existing document checks its terminal without switching the window',async()=>{
 const f=presentation();
 const run=f.$.process.run;f.$.process.run=async(argv,opts)=>argv.at(-1)==='ls'?ran(0,'{"spaces":[]}'):run(argv,opts);
 f.files.set(`${DIR}/missing-terminal.json`,JSON.stringify(quotaSpec));
 const answer=await present(f.$,'missing-terminal',quotaSpec,appHere);
 expect('result' in answer && answer.result).toContain("could not find this session's terminal");
 expect(f.calls.some(a=>a.includes('do'))).toBe(false);
});
test("a view is its app terminal's, else the driven session's whose key its environment holds", async () => {
  const withEnv = (key: string | undefined) => ({ env: { get: async (name: string) => (name === 'COCKPIT_SESSION_KEY' ? key : undefined) } }) as unknown as Parameters<typeof viewOwner>[0]
  const app = { frontend: 'app', terminal: 't42', paneId: 'p1' } as unknown as Parameters<typeof viewOwner>[1]
  expect(await viewOwner(withEnv('claude:1794-0'), app)).toBe('t42')
  expect(await viewOwner(withEnv('claude:1794-0'), undefined)).toBe('claude:1794-0')
  expect(await viewOwner(withEnv('claude:1794-0/../x'), undefined)).toBe(undefined)
  expect(await viewOwner(withEnv(undefined), undefined)).toBe(undefined)
})

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
const address = `data:text/javascript,${encodeURIComponent(await readFile(new URL('../mods/cockpit/address.js',import.meta.url),'utf8'))}`;
const source = (await readFile(new URL('../mods/cockpit/window.js',import.meta.url),'utf8')).replace('"./address.js"',JSON.stringify(address));
const {runWindowCommand} = await import(`data:text/javascript,${encodeURIComponent(source)}`);
function fixture() {
  const calls=[], runs=[], clip=[];
  const spaces={spaces:[{id:"s1",machine:"runner",tabs:[{id:"tab1",terminals:[{terminal:"runner/t3",pane:"p3"}]}]},
    {id:"s2",machine:null,tabs:[{id:"tab2",terminals:[{terminal:"t3",pane:"p4"}]}]}]};
  return {calls,runs,clip, options:{machine:"runner",now:()=>100,run:c=>runs.push(c),
    clipboard:{read:async()=>"before",write:async text=>clip.push(text)},
    herdrApp:async argv=>{calls.push(argv); return {code:0,stdout:JSON.stringify(argv[0]==="ls"?spaces:{terminal:"runner/t9"}),stderr:""};}}};
}
const command=(name,args={})=>({id:7,cmd:"do",command:name,args,deadline:200});
test("ls keeps the runner's spaces with runner addresses",async()=>{
  const f=fixture(), r=await runWindowCommand({cmd:"ls",deadline:200},f.options);
  assert.equal(r.value.spaces.length,1); assert.equal(r.value.spaces[0].tabs[0].terminals[0].terminal,"t3");
});
test("an expired command and an unknown command do not run",async()=>{
  const f=fixture(); assert.ok((await runWindowCommand({...command("pane.focus"),deadline:99},f.options)).error);
  assert.ok((await runWindowCommand(command("space.delete-everything"),f.options)).error); assert.equal(f.calls.length,0);
});
test("pane.focus reaches the runner terminal and normalizes the answer",async()=>{
  const f=fixture(), r=await runWindowCommand(command("pane.focus",{terminal:"t3"}),f.options);
  assert.deepEqual(f.calls.at(-1),["do","pane.focus",'{"terminal":"runner/t3"}']); assert.equal(r.value.terminal,"t9");
});
test("mutations cannot target the desktop's own space tab or pane",async()=>{
  for(const [name,args] of [["space.close",{id:"s2"}],["tab.rename",{id:"tab2",name:"acme"}],["pane.close",{pane:"p4"}],["pane.focus",{}]]) {
    const f=fixture(); assert.ok((await runWindowCommand(command(name,args),f.options)).error,name);
    assert.equal(f.calls.filter(c=>c[0]==="do").length,0);
  }
});
test("space.new forces the runner and returns the runner terminal address",async()=>{
  const f=fixture(), r=await runWindowCommand(command("space.new",{machine:"laptop",folder:"/src/acme/api"}),f.options);
  assert.equal(JSON.parse(f.calls.at(-1)[2]).machine,"runner"); assert.equal(r.value.terminal,"t9");
});
test("unverified terminal creation is refused rather than running on the desktop",async()=>{
  for(const [name,args] of [["terminal.open",{argv:["sh"]}],["tab.new",{space:"s1",argv:["sh"]}],["pane.split",{pane:"p3",argv:["sh"]}]]) {
    const f=fixture(); assert.ok((await runWindowCommand(command(name,args),f.options)).error);
    assert.equal(f.calls.filter(c=>c[0]==="do").length,0);
  }
});
test("cockpit.doc-shown names the runner's terminal as the desktop does, and only the runner's",async()=>{
  const f=fixture(); assert.deepEqual(await runWindowCommand(command("cockpit.doc-shown:t3:quota|Quota: ENG-412"),f.options),{value:{}});
  assert.deepEqual(f.runs,["cockpit.doc-shown:runner/t3:quota|Quota: ENG-412"]);
  const g=fixture(); assert.ok((await runWindowCommand(command("cockpit.doc-shown:t8:quota|Quota"),g.options)).error);
  assert.deepEqual(g.runs,[]);
});
test("cockpit.panel-open:show:quota runs in the window",async()=>{
  const f=fixture(); assert.deepEqual(await runWindowCommand(command("cockpit.panel-open:show:quota"),f.options),{value:{}});
  assert.deepEqual(f.runs,["cockpit.panel-open:show:quota"]);
});
test("terminal.paste pastes text through the desktop clipboard and restores it",async()=>{
  const f=fixture(); await runWindowCommand(command("terminal.paste",{terminal:"t3",text:"Ship ENG-412"}),f.options);
  assert.deepEqual(f.clip,["Ship ENG-412","before"]);
  assert.deepEqual(f.calls.at(-1),["do","terminal.paste",'{}']);
});
test('tab.select is allowed only for a runner tab',async()=>{
 const f=fixture();assert.ok((await runWindowCommand(command('tab.select',{id:'tab1'}),f.options)).value);
 assert.ok((await runWindowCommand(command('tab.select',{id:'tab2'}),f.options)).error);
});
test('an authenticated item focus applies its full target locally',async()=>{
 const f=fixture(),targets=[];
 const result=await runWindowCommand(command('cockpit.focus',{target:{app:'runbook',key:'eng-412',steps:['2']}}),{...f.options,focus:target=>targets.push(target)});
 assert.deepEqual(result,{value:{}});assert.deepEqual(targets,[{app:'runbook',key:'eng-412',steps:['2']}]);
});

test('runner cockpit panes can close and zoom while local mod panes are refused',async()=>{
 for(const name of ['pane.close','pane.zoom']) {
  const f=fixture();
  f.options.panes=()=>[{pane:'pdoc',tab:'tab1',mod:'cockpit'},{pane:'plocal',tab:'tab2',mod:'cockpit'}];
  assert.ok((await runWindowCommand(command(name,{pane:'pdoc'}),f.options)).value);
  assert.deepEqual(f.calls.at(-1),['do',name,'{"pane":"pdoc"}']);
  assert.ok((await runWindowCommand(command(name,{pane:'plocal'}),f.options)).error);
  assert.ok((await runWindowCommand(command(name,{pane:'pdoc',terminal:'t3'}),f.options)).error);
 }
});
test('paste focuses the verified runner terminal before using the focused-terminal ABI',async()=>{
 const f=fixture();
 await runWindowCommand(command('terminal.paste',{terminal:'t3',text:'ENG-412'}),f.options);
 assert.deepEqual(f.calls.filter(c=>c[0]==='do'),[['do','pane.focus','{"terminal":"runner/t3"}'],['do','terminal.paste','{}']]);
});
test('a failed focus prevents paste and clipboard changes',async()=>{
 const f=fixture(), app=f.options.herdrApp;
 f.options.herdrApp=async args=>args[1]==='pane.focus'?{code:1,stderr:'focus refused'}:app(args);
 assert.ok((await runWindowCommand(command('terminal.paste',{terminal:'t3',text:'ENG-412'}),f.options)).error);
 assert.deepEqual(f.clip,[]); assert.equal(f.calls.filter(c=>c[1]==='terminal.paste').length,0);
});
test('paste by pane resolves its runner terminal and rechecks expiry after focus',async()=>{
 const f=fixture(), app=f.options.herdrApp;
 let clock=100; f.options.now=()=>clock;
 f.options.herdrApp=async args=>{const r=await app(args);if(args[1]==='pane.focus')clock=201;return r;};
 assert.equal((await runWindowCommand(command('terminal.paste',{pane:'p3',text:'ENG-412'}),f.options)).error,'expired');
 assert.deepEqual(f.clip,[]); assert.equal(f.calls.filter(c=>c[1]==='terminal.paste').length,0);
});

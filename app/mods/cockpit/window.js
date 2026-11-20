// The desktop accepts a bounded set of runner commands and checks every terminal target against its machine.
import { toRunner, toDesktop } from "./address.js";

export const WINDOW_COMMANDS = new Set(["ls","status","pane.split","pane.focus","pane.zoom","pane.close","space.select","space.rename","tab.rename","tab.select","tab.close","space.close","layout.switch","layout.select","terminal.paste","space.new","tab.new","terminal.open","cockpit.focus"]);

function runnerValue(value, machine) {
  if (Array.isArray(value)) return value.map(v => runnerValue(v,machine));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key,v]) => [key,key === "terminal" && typeof v === "string" ? toRunner(v,machine) : runnerValue(v,machine)]));
}

export async function runWindowCommand(cmd, {machine,now=Date.now,herdrApp,run,clipboard,focus,panes=()=>[]}) {
  try {
    const expired = () => !Number.isFinite(cmd.deadline) || now() > cmd.deadline;
    if (expired()) return {error:"expired"};
    const name = cmd.cmd === "do" ? cmd.command : cmd.cmd;
    const cockpit = /^cockpit\.(go|panel-open):/.test(name ?? "");
    // `cockpit.doc-shown:<terminal>:<view>|<title>`: an agent showed a view; its terminal is checked and named as here.
    const shown = /^cockpit\.doc-shown:([^:]+):([\s\S]*)$/.exec(name ?? "");
    if (!WINDOW_COMMANDS.has(name) && !cockpit && !shown) return {error:`${name} is not a command this window runs for ${machine}`};
    if (!["do","ls","status"].includes(cmd.cmd)) return {error:"invalid window operation"};
    if (name === "cockpit.focus") { await focus(cmd.args?.target); return {value:{}}; }
    if (cockpit) { await run(name); return {value:{}}; }
    const call = async argv => {
      const r = await herdrApp(argv);
      if (r.code !== 0) throw new Error(r.stderr?.trim() || "the desktop refused the window command");
      const value = JSON.parse(r.stdout || "{}");
      if (value.error) throw new Error(value.error);
      return value;
    };
    if (shown) {
      const terminal = toDesktop(shown[1],machine);
      const listed = await call(["ls"]);
      const terms = (listed.spaces ?? []).filter(s=>s.machine===machine).flatMap(s=>s.tabs ?? []).flatMap(t=>t.terminals ?? []);
      if (!terms.some(t=>t.terminal===terminal)) return {error:`cockpit.doc-shown needs a target belonging to ${machine}`};
      await run(`cockpit.doc-shown:${terminal}:${shown[2]}`);
      return {value:{}};
    }
    if (cmd.cmd === "ls") {
      const listed = await call(["ls"]);
      return {value:runnerValue({...listed,spaces:(listed.spaces ?? []).filter(s=>s.machine===machine)},machine)};
    }
    if (cmd.cmd === "status") {
      const status = await call(["status"]);
      // A local desktop terminal is not a terminal the runner can address.
      if (typeof status.terminal === "string" && !status.terminal.startsWith(`${machine}/`)) delete status.terminal;
      return {value:runnerValue(status,machine)};
    }
    const args = {...(cmd.args ?? {})};
    if (name === "terminal.open" || name === "tab.new" || (name === "pane.split" && args.argv)) {
      return {error:`${name} cannot safely create a terminal on ${machine}: this desktop API's machine support is unverified`};
    }
    let pasteTerminal;
    if (name === "space.new") args.machine = machine;
    else if (!name.startsWith("layout.")) {
      const listed = await call(["ls"]);
      const owned = (listed.spaces ?? []).filter(s=>s.machine===machine);
      const tabs = owned.flatMap(s=>s.tabs ?? []);
      const terms = tabs.flatMap(t=>t.terminals ?? []);
      const ownedTabs = new Set(tabs.map(t=>t.id));
      const ownedPanes = panes().filter(p=>ownedTabs.has(p.tab));
      let valid;
      if (name.startsWith("space.")) valid = owned.some(s=>s.id===args.id);
      else if (name.startsWith("tab.")) valid = tabs.some(t=>t.id===args.id);
      else {
        if (args.terminal) args.terminal = toDesktop(args.terminal,machine);
        valid = Boolean(args.terminal || args.pane)
          && (!args.terminal || terms.some(t=>t.terminal===args.terminal))
          && (!args.pane || terms.some(t=>t.pane===args.pane) || ownedPanes.some(p=>p.pane===args.pane))
          && (!args.terminal || !args.pane || terms.some(t=>t.pane===args.pane && t.terminal===args.terminal));
        if (name === "terminal.paste") {
          pasteTerminal = args.terminal ?? terms.find(t=>t.pane===args.pane)?.terminal;
          valid &&= Boolean(pasteTerminal);
        }
      }
      if (!valid) return {error:`${name} needs a target belonging to ${machine}`};
      if (name === "pane.split" && args.mod !== "cockpit") return {error:"only cockpit panels can be split by the runner"};
    }
    if (expired()) return {error:"expired"};
    if (name === "terminal.paste") {
      await call(["do","pane.focus",JSON.stringify({terminal:pasteTerminal})]);
      if (expired()) return {error:"expired"};
    }
    if (name === "terminal.paste" && typeof args.text === "string") {
      if (!clipboard) return {error:"text paste is unavailable on this desktop"};
      const text = args.text; delete args.text;
      const before = await clipboard.read();
      try {
        await clipboard.write(text);
        if (expired()) return {error:"expired"};
        return {value:runnerValue(await call(["do",name,"{}"]),machine)};
      } finally { if (clipboard.wait) await clipboard.wait(); await clipboard.write(before); }
    }
    return {value:runnerValue(await call(["do",name,name === "terminal.paste" ? "{}" : JSON.stringify(args)]),machine)};
  } catch(error) { return {error:String(error?.message ?? error)}; }
}

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { Value } from "typebox/value";
import { createPerplexityClient } from "../../extensions/perplexity/perplexity.ts";

// Offline host UI seam only: production provider/evidence modules run unchanged.
const hooks = registerHooks({ resolve(specifier, context, next) {
  const coding = "export const getMarkdownTheme = () => ({});";
  const tui = `export class Input { setValue() {} invalidate() {} } export class Markdown {} export const matchesKey = (a,b) => a===b; export const truncateToWidth = (t,w) => t.slice(0,w); export const visibleWidth = t => t.length; export const wrapTextWithAnsi = t => [t];`;
  const source = specifier === "@earendil-works/pi-coding-agent" ? coding : specifier === "@earendil-works/pi-tui" ? tui : undefined;
  return source ? { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true } : next(specifier, context);
} });
const integration = await import("../../extensions/perplexity/index.ts");
hooks.deregister();
const turns = [
  { role: "user" as const, text: "question" },
  { role: "assistant" as const, text: "Second[8] unknown[2]", citations: [{ id: "8", title: "Eight", url: "https://example.com/eight" }] },
  { role: "user" as const, text: "followup" },
  { role: "assistant" as const, text: "Fourth[8]", citations: [{ id: "8", title: "Different", url: "https://example.com/different" }] },
];
async function fixture(t: any, research?: any) {
  const root = await mkdtemp(join(tmpdir(), "pi-perplexity-wiring-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new Map<string, any>(), commands = new Map<string, any>(), events = new Map<string, any[]>();
  const pi = { registerTool(tool: any) { assert.equal(tools.has(tool.name), false); tools.set(tool.name, tool); }, registerCommand(name: string, cmd: any) { commands.set(name, cmd); }, on(name: string, fn: any) { events.set(name, [...(events.get(name) ?? []), fn]); }, appendEntry() {} };
  const text = "Drug treatment improves outcome. However, only eligible adults benefit.";
  integration.registerPerplexityExtension(pi as any, {
    store: { root }, research: research ?? (async () => ({ responseId: "provider-r", content: "Answer[8] unknown[9]", citations: [{ id: "8", title: "Eight", url: "https://example.com/eight" }], unresolvedCitations: ["[9]"], usage: { total_tokens: 9, cost: { total_cost: 0.01 } } })),
    discover: async () => ({ requestId: "d", results: [{ id: "result-1", title: "Page", url: "https://example.com", snippet: "provider snippet" }] }),
    fetch: async url => ({ requestedUrl: url, finalUrl: url, fetchedAt: new Date(0).toISOString(), representation: "text", extractorVersion: "fixture", text, contentHash: createHash("sha256").update(text).digest("hex") }),
  });
  const ctx = { sessionManager: { getSessionId: () => "fixture-child", getBranch: () => [] } };
  return { tools, commands, events, ctx };
}
test("production default factory registers offline without provider/key operations", () => {
  const names: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network on load is forbidden"); };
  try {
    integration.default({ registerTool: (tool: any) => names.push(tool.name), registerCommand() {}, on() {}, appendEntry() {} } as any);
    assert.deepEqual(names, ["web_search", "fetch_content", "get_search_content", "source_check", "perplexity_research"]);
  } finally { globalThis.fetch = originalFetch; }
});
test("entry point registers exactly five strict machine-data tools plus explicit command, without loading credentials/network", async t => {
  const { tools, commands, events, ctx } = await fixture(t);
  assert.deepEqual([...tools.keys()], ["web_search", "fetch_content", "get_search_content", "source_check", "perplexity_research"]);
  assert.deepEqual([...commands.keys()], ["research"]);
  for (const tool of tools.values()) { assert.equal(tool.parameters.additionalProperties, false); assert.ok(tool.outputSchema); }
  for (const fn of events.get("session_start")!) await fn({}, ctx);
  const exec = (name: string, params: any) => tools.get(name).execute("fixture", params, undefined, undefined, ctx);
  const searched = await exec("web_search", { query: "treatment", includeContent: true });
  const fetched = await exec("fetch_content", { url: "https://example.com" });
  const checked = await exec("source_check", { claim: "drug treatment outcome", responseId: fetched.structuredContent.responseId });
  const read = await exec("get_search_content", { responseId: checked.structuredContent.responseId });
  const synthesized = await exec("perplexity_research", { query: "treatment" });
  for (const [name, result] of [["web_search", searched], ["fetch_content", fetched], ["source_check", checked], ["get_search_content", read], ["perplexity_research", synthesized]] as const) {
    assert.equal(Value.Check(tools.get(name).outputSchema, result.structuredContent), true, name);
    assert.deepEqual(result.details, result.structuredContent);
  }
  assert.equal(synthesized.structuredContent.kind, "provider-synthesis");
  assert.match(synthesized.structuredContent.content, /Answer\[t1:8\]/);
  assert.match(synthesized.structuredContent.content, /unresolved:t1:9/);
  assert.deepEqual(synthesized.structuredContent.externalUsage, { total_tokens: 9, cost: { total_cost: 0.01 } });
  assert.equal("usage" in synthesized, false); // do not invent Pi token/cost fields
  await assert.rejects(exec("get_search_content", { responseId: "provider-r" }), /invalid.*parameters/);
  for (const fn of events.get("session_shutdown")!) await fn({});
});
test("synthesis invalid/legacy arguments reject before provider, provider failures and abort remain failures", async t => {
  let calls = 0;
  const { tools } = await fixture(t, async () => { calls++; throw new Error("fixture provider failed"); });
  const synth = (params: any, signal?: AbortSignal) => tools.get("perplexity_research").execute("f", params, signal);
  for (const params of [{ query: " " }, { query: "x", preset: "high" }, { query: "x", model: "sonar" }, { query: "x", maxTokens: 0 }, { queries: ["x"] }]) await assert.rejects(synth(params), /expected query/);
  assert.equal(calls, 0);
  await assert.rejects(synth({ query: "x" }), /provider failed/); assert.equal(calls, 1);
  const c = new AbortController(); c.abort(); await assert.rejects(synth({ query: "x" }, c.signal), { name: "AbortError" }); assert.equal(calls, 1);
});
test("synthesis machine output stays complete under text truncation; malformed success fails loudly", async t => {
  const research = async () => ({ responseId: "long-provider", content: "x".repeat(20000), citations: [], unresolvedCitations: [] });
  const { tools } = await fixture(t, research);
  const result = await tools.get("perplexity_research").execute("f", { query: "x" });
  assert.equal(result.structuredContent.content.length, 20000);
  assert.ok(result.content[0].text.length < 16500);
  assert.match(result.content[0].text, /NOT an evidence-cache handle/);
  assert.equal(Value.Check(tools.get("perplexity_research").outputSchema, result.structuredContent), true);
  const malformed = await fixture(t, async () => ({ ...await research(), responseId: "", content: "" }));
  await assert.rejects(malformed.tools.get("perplexity_research").execute("f", { query: "x" }), /Invalid synthesis output schema/);
});
test("real normalized Search adapter connects to evidence native hour filter without schema drift", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-hour-wiring-")); t.after(() => rm(root, { recursive: true, force: true }));
  let sent: any;
  const provider = createPerplexityClient({ apiKey: () => "fixture", fetch: async (_u, init) => { sent = JSON.parse(init!.body as string); return new Response(JSON.stringify({ id: "hour", results: [] }), { headers: { "content-type": "application/json" } }); } });
  const tools = new Map<string, any>();
  integration.registerPerplexityExtension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, on() {}, appendEntry() {} } as any, { discover: provider.discoverPerplexity as any, store: { root } });
  const result = await tools.get("web_search").execute("f", { query: "x", recencyFilter: "hour" }, undefined, undefined, { sessionManager: { getSessionId: () => "s", getBranch: () => [] } });
  assert.equal(sent.search_recency_filter, "hour"); assert.equal(result.structuredContent.status, "complete");
});
test("recap scopes repeated IDs by turn and exposes unknown guessed associations", () => {
  const input = integration.transcriptToText(turns);
  assert.match(input, /Second\[t2:8\]/); assert.match(input, /Fourth\[t4:8\]/);
  const recap = integration.validatedRecap("Findings[t4:8] guessed[8] unknown[t2:99]", turns);
  assert.match(recap, /\[t4:8\] Different/); assert.doesNotMatch(recap, /\[t2:8\] Eight/);
  assert.match(recap, /unresolved:8/); assert.match(recap, /unresolved:t2:99/); assert.match(recap, /Unresolved citation references/);
});
test("command recap uses current Pi model offline then editable approval/manual submission only", async t => {
  const { commands } = await fixture(t); let loaded: string | undefined, modelCalls = 0, preview = "";
  const ctx: any = {
    mode: "tui", model: { id: "fixture" },
    modelRegistry: { complete: async (_model: any, prompt: any) => {
      modelCalls++; assert.match(prompt.messages[0].content[0].text, /Second\[t2:8\]/);
      return { stopReason: "stop", content: [{ type: "text", text: "## Key Findings\nEvidence[t2:8] guessed[8]" }] };
    } },
    ui: {
      custom: async (factory: any) => new Promise(resolve => {
        const panel: any = factory({ requestRender() {} }, {}, {}, resolve);
        panel.turns = turns; void panel.requestRecap();
      }),
      editor: async (_title: string, draft: string) => { preview = draft; assert.equal(loaded, undefined); return "edited approved draft"; },
      setEditorText: (text: string) => { loaded = text; }, notify() {},
    },
  };
  await commands.get("research").handler("", ctx);
  assert.equal(modelCalls, 1); assert.match(preview, /\[t2:8\] Eight/); assert.match(preview, /unresolved:8/); assert.equal(loaded, "edited approved draft");
  loaded = undefined; ctx.ui.editor = async () => undefined;
  await commands.get("research").handler("", ctx); assert.equal(loaded, undefined);
  ctx.mode = "json"; await commands.get("research").handler("", ctx); assert.equal(modelCalls, 2);
});
const subagentsPath = process.env.PI_SUBAGENTS_PATH ?? join(homedir(), ".pi/agent/npm/node_modules/pi-subagents");
const subagentsEntry = join(subagentsPath, "src/agents/agents.js");
const subagentsPrereq = `set SOF_PI_SUBAGENTS_INTEGRATION=1 with a compatible installed pi-subagents module (entry ${subagentsEntry}); override its location with PI_SUBAGENTS_PATH`;
test("installed pi-subagents discovery resolves package roles/load paths and higher-precedence shadows offline", { skip: process.env.SOF_PI_SUBAGENTS_INTEGRATION === "1" ? false : `opt-in integration smoke skipped (prerequisite: ${subagentsPrereq})` }, async t => {
  if (!existsSync(subagentsEntry)) assert.fail(`pi-subagents integration prerequisite not met: no module at ${subagentsEntry} — ${subagentsPrereq}`);
  let discovery: any;
  try {
    discovery = await import(pathToFileURL(subagentsEntry).href);
  } catch (error) {
    assert.fail(`pi-subagents integration prerequisite not met: ${subagentsEntry} failed to load (${(error as Error)?.message ?? error}) — ${subagentsPrereq}`);
  }
  if (typeof discovery.discoverAgents !== "function" || typeof discovery.clearAgentDiscoveryCache !== "function") {
    assert.fail(`pi-subagents integration prerequisite not met: ${subagentsPath} is not a compatible pi-subagents installation (missing discoverAgents/clearAgentDiscoveryCache exports) — ${subagentsPrereq}`);
  }
  const root = await mkdtemp(join(tmpdir(), "pi-profile-smoke-")); t.after(() => rm(root, { recursive: true, force: true }));
  const user = join(root, "user"), project = join(root, "project");
  await mkdir(join(project, ".pi"), { recursive: true }); await mkdir(join(user, "agents"), { recursive: true });
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = user;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; });
  const packageRoot = resolve(new URL("../..", import.meta.url).pathname);
  await writeFile(join(project, ".pi", "settings.json"), JSON.stringify({ packages: [packageRoot] }));
  discovery.clearAgentDiscoveryCache();
  const roles = discovery.discoverAgents(project, "both", undefined, { globalNpmRoot: null });
  const registered = [...(await fixture(t)).tools.keys()];
  for (const name of ["researcher", "evidence-auditor"]) {
    const agent = roles.agents.find((a: any) => a.name === name);
    assert.ok(agent); assert.equal(agent.source, "package");
    assert.deepEqual(agent.extensions, []);
    assert.deepEqual(agent.subagentOnlyExtensions, [join(packageRoot, "extensions/perplexity/index.ts")]);
    for (const tool of agent.tools) assert.ok(["read", "write", ...registered].includes(tool), `missing preflight tool ${tool}`);
    assert.equal(agent.tools.includes("perplexity_research"), false);
    assert.doesNotMatch(agent.systemPrompt, /workflow:|confidence: 0/);
  }
  assert.equal(roles.agents.find((a: any) => a.name === "evidence-auditor").defaultContext, "fresh");
  await writeFile(join(user, "agents", "researcher.md"), "---\nname: researcher\ndescription: user fixture\ntools: read\n---\nUser shadow.");
  discovery.clearAgentDiscoveryCache();
  assert.equal(discovery.discoverAgents(project, "both", undefined, { globalNpmRoot: null }).agents.find((a: any) => a.name === "researcher").source, "user");
  await mkdir(join(project, ".pi/agents"), { recursive: true });
  await writeFile(join(project, ".pi/agents/researcher.md"), "---\nname: researcher\ndescription: project fixture\ntools: read\n---\nProject shadow.");
  discovery.clearAgentDiscoveryCache();
  assert.equal(discovery.discoverAgents(project, "both", undefined, { globalNpmRoot: null }).agents.find((a: any) => a.name === "researcher").source, "project");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.ok(manifest.pi.extensions.includes("./extensions/perplexity/index.ts"));
  assert.ok(manifest.scripts.test.includes("tests/factory/*.test.ts")); assert.ok(manifest.scripts.test.includes("tests/perplexity/*.test.ts"));
});

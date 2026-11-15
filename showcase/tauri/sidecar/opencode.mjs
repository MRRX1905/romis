// The brain runs on the opencode CLI installed on this computer: no API key, no sign-in here. Roamies starts
// `opencode serve`, gives it our tools as a local MCP server (so safety.mjs and HANDS_OFF still guard every call)
// and our system prompt as the agent's AGENTS.md, then drives one session per conversation.
// OpenCodeAgent has the surface sidekick.mjs uses of gg-agent's Agent; the CLI never drives tools itself.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AgentStream } from '@kenkaiiii/gg-agent';
import { createToolBridge, renderTranscript } from './claudecode.mjs';

export const AGENT_DIR = path.join(os.homedir(), '.gg', 'sidekick', 'opencode');
const MCP_NAME = 'roamies';
const AGENT_NAME = 'roamies';
const SHIM = path.join(AGENT_DIR, 'mcp-shim.mjs');
const SHIM_SOURCE = `// Roamies' tools, for opencode: its stdin/stdout MCP stream is piped to the sidecar over loopback.
import net from 'node:net';
const [host, port] = String(process.env.ROAMIES_MCP_URL ?? '').split(':');
const token = String(process.env.ROAMIES_MCP_TOKEN ?? '');
const sock = net.connect({ host, port: Number(port) });
sock.setEncoding('utf8');
sock.on('connect', () => sock.write(JSON.stringify({ token }) + '\\n'));
sock.on('data', (d) => process.stdout.write(d));
sock.on('error', () => process.exit(0));
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { if (sock.writable) sock.write(d); });
process.stdin.on('end', () => sock.end());
`;
const START_TIMEOUT_MS = 30_000;
const IDLE_MS = 240_000; // no new output for this long: the run is over
const POLL_MS = 120;
const MAX_TURNS = 24;

/** "provider/model" → { providerID, id }; a bare name stays in the default provider. */
export function modelRef(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const i = raw.indexOf('/');
  return i > 0 ? { providerID: raw.slice(0, i), id: raw.slice(i + 1) } : { providerID: 'opencode', id: raw };
}
export const modelId = (m) => (m ? `${m.providerID}/${m.id}` : '');

/** opencode's MCP tool names carry a prefix ("mcp__roamies__read_file"); ours are the bare name. */
export const stripToolPrefix = (name) => String(name ?? '').replace(/^mcp__[^_]+__/, '');

/** The two lines `opencode serve` prints when it is ready: the port, then the password Basic auth needs. */
export function parseServerLine(line) {
  const s = String(line ?? '');
  const at = s.match(/server listening on http:\/\/127\.0\.0\.1:(\d+)/);
  if (at) return { port: Number(at[1]) };
  const pw = s.match(/server password (\S+)/);
  if (pw) return { password: pw[1] };
  return null;
}

const textOf = (content) => (typeof content === 'string' ? content
  : (content ?? []).map((c) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : '')).join('\n'));

/**
 * One poll of the session's assistant messages → the events since the last poll. Text and reasoning arrive as
 * growing strings, tool calls as a state that goes streaming → running → completed; the diff is the stream.
 * state: { text: '', reasoning: '', tools: Map(id → 'started'|'ended'), turns: 0 }
 */
export function emitParts(state, parts) {
  const out = [];
  for (const p of parts ?? []) {
    if (p?.type === 'text') {
      const full = String(p.text ?? '');
      if (full.length > state.text.length) { out.push({ type: 'text_delta', text: full.slice(state.text.length) }); state.text = full; }
    } else if (p?.type === 'reasoning') {
      const full = String(p.text ?? '');
      if (full.length > state.reasoning.length) { out.push({ type: 'thinking_delta', text: full.slice(state.reasoning.length) }); state.reasoning = full; }
    } else if (p?.type === 'tool') {
      const id = String(p.id ?? ''), name = stripToolPrefix(p.name), status = p.state?.status;
      if (!state.tools.has(id) && (status === 'streaming' || status === 'running')) {
        state.tools.set(id, 'started');
        out.push({ type: 'tool_call_start', toolCallId: id, name, args: p.state?.input ?? {} });
      } else if (state.tools.get(id) === 'started' && (status === 'completed' || status === 'error')) {
        state.tools.set(id, 'ended');
        out.push({
          type: 'tool_call_end', toolCallId: id,
          result: status === 'completed' ? textOf(p.state?.content) : String(p.state?.error ?? p.state?.content ?? 'failed'),
          isError: status === 'error', durationMs: p.time?.ran ? (p.time.completed ?? 0) - p.time.ran : 0,
        });
      }
    }
  }
  return out;
}

/** The assistant messages and the diff events for the newest one, from a /message list. */
export function pollMessages(state, messages) {
  const all = messages ?? [];
  // A run that failed (a limit, a bad key, a provider error) ends with an idle message saying why.
  const idle = all.find((m) => m?.type === 'idle');
  const fail = idle?.outcome === 'failed' ? String(idle.error?.message ?? 'opencode stopped') : null;
  const last = all.filter((m) => m?.type === 'assistant').at(-1);
  if (!last) return { events: [], done: false, fail };
  const fresh = last.id !== state.messageId;
  if (fresh) { state.messageId = last.id; state.text = ''; state.reasoning = ''; state.tools = new Map(); }
  const events = emitParts(state, last.content);
  return { events, done: !!last.time?.completed, fail: fail ?? (last.error?.message ? String(last.error.message) : null) };
}

// ---------- the server ----------
let server = null; // { proc, port, password, ready, lines }
let mcp = null;    // { listener, url, token, bridge }

function apiPath(port, p) { return `http://127.0.0.1:${port}${p}`; }

async function api(p, { method = 'GET', body, password } = {}) {
  const s = await ensureServer();
  const res = await fetch(apiPath(s.port, p), {
    method,
    headers: {
      authorization: 'Basic ' + Buffer.from(`opencode:${password ?? s.password}`).toString('base64'),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`opencode ${method} ${p} → ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
  try { return text ? JSON.parse(text) : null; } catch { return text; }
}

/** Starts `opencode serve` on a free port, once; throws a message the user can act on when it isn't installed. */
export async function ensureServer() {
  if (server?.ready) return server;
  if (server?.starting) return server.starting;
  const bin = process.env.ROAMIES_OPENCODE || 'opencode';
  // Windows ships opencode as a .cmd shim, which only cmd.exe runs; elsewhere it is a plain executable.
  const win = process.platform === 'win32';
  const command = win ? process.env.ComSpec || 'cmd.exe' : bin;
  const args = win ? ['/c', bin, 'serve', '--port', '0'] : ['serve', '--port', '0'];
  const proc = spawn(command, args, {
    cwd: fs.existsSync(AGENT_DIR) ? AGENT_DIR : os.homedir(),
    env: { ...process.env },
    windowsHide: true,
  });
  const s = server = { proc, port: 0, password: '', ready: false, lines: '' };
  s.starting = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`opencode did not start. Is it installed and on PATH? (${bin})`)), START_TIMEOUT_MS);
    const onData = (chunk) => {
      s.lines = (s.lines + String(chunk)).slice(-4000);
      for (const line of String(chunk).split(/\r?\n/)) {
        const parsed = parseServerLine(line);
        if (parsed?.port) s.port = parsed.port;
        if (parsed?.password) s.password = parsed.password;
      }
      if (s.port && s.password && !s.ready) {
        s.ready = true; clearTimeout(timer); resolve(s);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => { clearTimeout(timer); reject(new Error(`opencode couldn't be started: ${e.message}`)); });
    proc.on('exit', (code) => {
      server = null;
      if (!s.ready) { clearTimeout(timer); reject(new Error(`opencode stopped (${code}): ${s.lines.slice(-300).trim()}`)); }
    });
  });
  try { return await s.starting; } catch (e) { stopServer(); throw e; }
}

export function stopServer() {
  const s = server; server = null;
  try { s?.proc?.kill(); } catch {}
  closeMcp();
}

function closeMcp() {
  try { mcp?.listener?.close(); } catch {}
  mcp = null;
}

/**
 * The MCP server opencode connects to: its socket is our tools, in this process (safety and all). Opened on its own,
 * so it can be exercised without opencode running.
 */
export async function openToolServer() {
  if (mcp) return mcp;
  const token = crypto.randomBytes(16).toString('hex');
  const bridgeRef = { current: null };
  const listener = createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '', authed = false;
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        if (!authed) {
          authed = (() => { try { return JSON.parse(line)?.token === token; } catch { return false; } })();
          if (!authed) { sock.destroy(); return; }
          continue;
        }
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        bridgeRef.current?.transport?.onmessage?.(msg);
      }
    });
    if (!authed) setTimeout(() => { if (!authed) sock.destroy(); }, 5_000).unref?.();
    const transport = {
      send: async (msg) => { if (sock.writable) sock.write(JSON.stringify(msg) + '\n'); },
      start: async () => {},
    };
    mcp.transport = transport;
    const bridge = bridgeRef.current;
    if (bridge) { bridge.transport = transport; bridge.instance.connect(transport).catch(() => {}); }
  });
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  mcp = { listener, token, bridgeRef, url: `127.0.0.1:${listener.address().port}`, shim: SHIM };
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  fs.writeFileSync(SHIM, SHIM_SOURCE);
  return mcp;
}

/** What opencode says about the MCP servers it knows (for diagnostics and tests). */
export async function mcpStatus() { return api('/api/mcp'); }

/** Points the open tool server at this run's tools (no opencode needed: the shim speaks to it directly). */
export async function attachTools(tools, signal, onEvent) {
  const m = await openToolServer();
  // createToolBridge hands its MCP server back as `config.instance` (that is what Claude Code mounts).
  const built = createToolBridge({ tools, signal, onEvent });
  m.bridgeRef.current = { instance: built.config.instance, takeResult: built.takeResult, transport: null };
  // An agent is rebuilt whenever settings or the model change: the client is already connected, so hand it the new
  // tools over the same socket instead of leaving it with the old ones.
  if (m.transport) {
    m.bridgeRef.current.transport = m.transport;
    built.config.instance.connect(m.transport).catch(() => {});
  }
  return m;
}

/** Points the open tool server at this run's tools, and registers it with opencode (idempotent). */
export async function registerTools(tools, signal, onEvent) {
  await ensureServer();
  const m = await attachTools(tools, signal, onEvent);
  const body = {
    config: {
      type: 'local',
      command: [process.execPath, SHIM],
      environment: { ROAMIES_MCP_URL: m.url, ROAMIES_MCP_TOKEN: m.token },
      timeout: { startup: 30_000, catalog: 60_000, execution: 330_000 },
    },
  };
  await api(`/api/experimental/mcp/${MCP_NAME}`, { method: 'PUT', body }).catch((e) => {
    // A server already registered with another command is replaced on the next start; not fatal for the run.
    console.error('[opencode] mcp', e.message);
  });
  await api(`/api/experimental/mcp/${MCP_NAME}/connect`, { method: 'POST', body: {} }).catch(() => {});
}

/**
 * The agent opencode runs for us: our system prompt, and every tool of opencode's own denied. Only the MCP server
 * we registered is allowed, so a file read, a command or a click still goes through safety.mjs and HANDS_OFF.
 * Written into the agent folder's config, which merges with the user's own (their providers and models stay).
 */
function writeInstructions(system) {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  const config = path.join(AGENT_DIR, 'opencode.json');
  const want = JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    agents: {
      roamies: {
        mode: 'primary',
        description: 'Roamies: the tools are the app\'s own, over MCP.',
        system: system ?? '',
        permissions: [
          { action: '*', resource: '*', effect: 'deny' },
          { action: 'mcp', resource: '*', effect: 'allow' },
          { action: 'question', resource: '*', effect: 'deny' },
          { action: 'browser', resource: '*', effect: 'deny' },
          { action: 'skill', resource: '*', effect: 'deny' },
        ],
      },
    },
  }, null, 2);
  try { if (fs.readFileSync(config, 'utf8') !== want) fs.writeFileSync(config, want); } catch { fs.writeFileSync(config, want); }
}

/** The models this computer's opencode offers, as "provider/id", for the Model page and the picker. */
export async function listModels() {
  const r = await api('/api/model');
  return (r?.data ?? []).map((m) => ({ id: `${m.providerID}/${m.id}`, name: m.name || m.id, provider: m.providerID }));
}

/** Is opencode installed and answering? → { ok, version?, models, reason? } */
export async function status() {
  try {
    const info = await api('/api/info').catch(() => null);
    const models = await listModels();
    return { ok: true, models, version: info?.version ?? null };
  } catch (e) {
    return { ok: false, models: [], reason: e instanceof Error ? e.message : String(e) };
  }
}

/** A session for this conversation: created once, then continued, so opencode keeps its own memory of it. */
async function openSession({ sessionId, model, system }) {
  writeInstructions(system);
  const ref = modelRef(model) ?? { providerID: 'opencode', id: '' };
  if (sessionId) {
    const found = await api(`/api/session/${sessionId}`).catch(() => null);
    if (found?.data?.id) {
      if (model) await api(`/api/session/${sessionId}/model`, { method: 'POST', body: { model: ref } }).catch(() => {});
      return sessionId;
    }
  }
  const created = await api('/api/session', {
    method: 'POST',
    body: { model: ref, agent: AGENT_NAME },
  });
  const id = created?.data?.id;
  if (!id) throw new Error('opencode made no session');
  return id;
}

/** The SSE feed, split into events; one reader for the whole process. */
function subscribe(onEvent) {
  const ctl = new AbortController();
  const s = server;
  const headers = { authorization: 'Basic ' + Buffer.from(`opencode:${s.password}`).toString('base64') };
  void (async () => {
    for (;;) {
      try {
        const res = await fetch(apiPath(s.port, '/api/event'), { headers, signal: ctl.signal });
        if (!res.ok || !res.body) throw new Error(`sse ${res.status}`);
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await res.body.getReader().read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = chunk.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            try { onEvent(JSON.parse(line.slice(5).trim())); } catch {}
          }
        }
      } catch { /* closed or the server went away */ }
      if (ctl.signal.aborted) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  return () => ctl.abort();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits for the session to go idle while polling its messages; yields { events } and { finished }. */
async function* follow(sessionId, { signal }) {
  const state = { text: '', reasoning: '', tools: new Map(), turns: 0, messageId: null };
  let idle = false, failure = null, lastOutput = Date.now();
  const off = subscribe((ev) => {
    const sid = ev?.data?.sessionID ?? ev?.sessionID;
    if (sid && sid !== sessionId) return;
    if (ev?.type === 'session.idle') idle = true;
    else if (ev?.type === 'session.execution.failed') failure = String(ev?.data?.error ?? 'opencode stopped');
    else if (ev?.type?.startsWith('session.')) lastOutput = Date.now();
    if (ev?.type === 'session.execution.succeeded' || ev?.type === 'session.execution.failed' || ev?.type === 'session.execution.interrupted') idle = true;
  });
  try {
    for (;;) {
      if (signal?.aborted) { await api(`/api/session/${sessionId}/interrupt`, { method: 'POST', body: {} }).catch(() => {}); break; }
      const listed = await api(`/api/session/${sessionId}/message?order=asc&limit=200`).catch(() => null);
      const { events, done, fail } = pollMessages(state, listed?.data ?? []);
      if (events.length) lastOutput = Date.now();
      for (const e of events) yield { event: e };
      if (fail) throw new Error(fail);
      if (failure) throw new Error(failure);
      if (done) {
        // The message is completed: give it a moment for any last part, then the run is over (opencode's
        // `session.idle` is a bonus, not the trigger: it does not always arrive for a one-turn session).
        let settled = 0;
        while (settled < 6) {
          await sleep(POLL_MS);
          const again = await api(`/api/session/${sessionId}/message?order=asc&limit=200`).catch(() => null);
          const more = pollMessages(state, again?.data ?? []).events;
          for (const e of more) yield { event: e };
          settled = more.length ? 0 : settled + 1;
        }
        yield { finished: true };
        return;
      }
      if (idle) { yield { finished: true }; return; }
      if (Date.now() - lastOutput > IDLE_MS) { yield { finished: true }; return; }
      await sleep(POLL_MS);
    }
  } finally { off(); }
}

/**
 * prompt(content) → AgentStream, getMessages(), setSignal(). Options: model, system, priorMessages, tools,
 * maxTurns, thinking, signal, executable (unused: the CLI on PATH), sessionId, onSession(id).
 */
export class OpenCodeAgent {
  #running = false;
  constructor(options) {
    this.options = options;
    this.messages = [...(options.system ? [{ role: 'system', content: options.system }] : []), ...(options.priorMessages ?? [])];
    this.sessionId = options.sessionId ?? null;
    this.state = { text: '', reasoning: '', tools: new Map(), turns: 0, messageId: null };
  }
  getMessages() { return [...this.messages]; }
  setSignal(signal) { this.options = { ...this.options, signal }; }
  wake() {}
  warm() {}
  prompt(content) {
    if (this.#running) throw new Error('Agent is already running');
    this.#running = true;
    this.messages.push({ role: 'user', content });
    return new AgentStream(this.#run(content), () => { this.#running = false; });
  }
  async *#run(content) {
    const o = this.options;
    await ensureServer();
    await registerTools(o.tools ?? [], () => o.signal, (event) => { (this.pending ??= []).push(event); });
    const fresh = !this.sessionId;
    this.sessionId = await openSession({ sessionId: this.sessionId, model: o.model, system: o.system });
    o.onSession?.(this.sessionId);
    const wrapped = o.wrapPrompt ? await o.wrapPrompt(content) : content;
    // A new opencode session never saw the conversation: it gets the history first, as text.
    const prior = fresh ? this.messages.slice(0, -1) : [];
    const seeded = fresh && prior.some((m) => m.role !== 'system') ? `${renderTranscript(prior, 200_000)}\n\n` : '';
    const text = seeded + (typeof wrapped === 'string' ? wrapped : textOf(wrapped));
    await api(`/api/session/${this.sessionId}/prompt`, { method: 'POST', body: { text } });
    const parts = [];
    let turns = 0, totalUsage = { inputTokens: 0, outputTokens: 0 };
    for await (const item of follow(this.sessionId, { signal: o.signal })) {
      for (const event of this.#drain()) yield event;
      if (item.event) {
        const e = item.event;
        if (e.type === 'text_delta') { parts.push({ type: 'text', text: e.text }); }
        yield e;
      }
      if (item.finished) {
        turns++;
        yield { type: 'turn_end', turn: turns, stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 }, timing: { startedAt: Date.now(), completedAt: Date.now(), providerDurationMs: 0 } };
        break;
      }
    }
    const assistant = { role: 'assistant', content: mergeText(parts) };
    this.messages.push(assistant);
    yield { type: 'agent_done', totalTurns: Math.max(1, turns), totalUsage };
  }
  #drain() { const p = this.pending ?? []; this.pending = []; return p; }
}

// Text deltas collected back into one block, so the saved turn reads like what was said.
function mergeText(parts) {
  const text = parts.map((p) => p.text).join('');
  return text ? [{ type: 'text', text }] : [];
}

/**
 * One tool-less turn on opencode, for the side calls (folding old turns, the memory pass): resolves the reply text.
 * Throws when opencode isn't there; callers treat that as the side call failing, as before.
 */
export async function oneShot({ text, system, model, signal, timeoutMs = 120_000 }) {
  await ensureServer();
  writeInstructions(system ?? 'You only write JSON. Reply with one JSON object and nothing else.');
  const sid = await openSession({ sessionId: null, model, system: system ?? '' });
  const ctl = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  try {
    await api(`/api/session/${sid}/prompt`, { method: 'POST', body: { text } });
    let out = '';
    for await (const item of follow(sid, { signal: ctl })) {
      if (item.event?.type === 'text_delta') out += item.event.text;
      if (item.finished) break;
    }
    return out.trim();
  } finally {
    await api(`/api/session/${sid}`, { method: 'DELETE' }).catch(() => {});
  }
}

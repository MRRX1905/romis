// The MCP route, end to end without a model: our tools are served to opencode's MCP client (the shim it launches),
// and a call comes back as a result plus the tool events the UI shows. This is the path every file, command and click
// Roamies makes goes through, so it is checked here rather than trusted.
// Run: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { attachTools, stopServer } from '../opencode.mjs';

const ran = [];
const readFile = {
  name: 'read_file', description: 'Read a text file',
  parameters: z.object({ path: z.string() }),
  execute: async ({ path }) => { ran.push(path); return 'pancake'; },
};
const events = [];
const m = await attachTools([readFile], () => null, (e) => events.push(e));

// The shim exactly as opencode starts it: node <shim>, our endpoint and token in its environment.
const shim = spawn(process.execPath, [m.shim], {
  env: { ...process.env, ROAMIES_MCP_URL: m.url, ROAMIES_MCP_TOKEN: m.token },
  stdio: ['pipe', 'pipe', 'inherit'],
});
const waiting = new Map();
let buf = '', seq = 0;
shim.stdout.setEncoding('utf8');
shim.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    waiting.get(msg.id)?.(msg);
  }
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq;
  waiting.set(id, resolve);
  shim.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => reject(new Error(`no answer to ${method}`)), 10_000).unref?.();
});

try {
  const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'opencode', version: '2' } });
  assert.equal(init.result.serverInfo.name, 'gg', 'our MCP server introduces itself');

  const listed = await rpc('tools/list', {});
  assert.deepEqual(listed.result.tools.map((t) => t.name), ['read_file'], 'our tools are what the client sees');
  assert.deepEqual(Object.keys(listed.result.tools[0].inputSchema.properties), ['path'], 'with their input schema');

  const called = await rpc('tools/call', { name: 'read_file', arguments: { path: '~/a.txt' } });
  assert.deepEqual(called.result.content, [{ type: 'text', text: 'pancake' }], 'the tool runs in the sidecar and answers');
  assert.deepEqual(ran, ['~/a.txt'], 'and it really ran, through safety.mjs like every tool');
  assert.deepEqual(events.map((e) => e.type), ['tool_call_start', 'tool_call_end'], 'the UI gets its start and end');
  assert.equal(events[0].name, 'read_file');
  assert.equal(events[0].args.path, '~/a.txt');
  assert.equal(events[1].result, 'pancake');

  // A tool that throws comes back as an MCP error result, not a crash. The agent is rebuilt between requests, so
  // this also checks that the connected client is handed the new tools over the same socket.
  const bad = await attachTools([{ ...readFile, name: 'boom', execute: async () => { throw new Error('nope'); } }], () => null, () => {});
  assert.equal(bad.url, m.url, 'one server, repointed per run');
  await new Promise((r) => setTimeout(r, 50));
  const failed = await rpc('tools/call', { name: 'boom', arguments: { path: 'x' } });
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /nope/);

  // An unknown tool is refused in words the model can act on.
  const missing = await rpc('tools/call', { name: 'nope', arguments: {} });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /nope/);

  // No dangling unhandled rejection from a tool that answers with a plain object (it used to throw inside the bridge
  // while formatting its own result, which took the whole sidecar down) or with content blocks.
  await attachTools([{ ...readFile, name: 'object_tool', execute: async () => ({ ok: true, text: 'pancake' }) }], () => null, () => {});
  await new Promise((r) => setTimeout(r, 50));
  const object = await rpc('tools/call', { name: 'object_tool', arguments: { path: 'x' } });
  assert.equal(object.result.isError, undefined, 'an object result is a success, not an error');
  assert.deepEqual(JSON.parse(object.result.content[0].text), { ok: true, text: 'pancake' }, 'shown to the model as JSON');

  await attachTools([{ ...readFile, name: 'blocks', execute: async () => [{ type: 'text', text: 'dua' }] }], () => null, () => {});
  await new Promise((r) => setTimeout(r, 50));
  const blocks = await rpc('tools/call', { name: 'blocks', arguments: { path: 'x' } });
  assert.deepEqual(blocks.result.content, [{ type: 'text', text: 'dua' }], 'content blocks pass through');
} finally {
  shim.kill();
  stopServer();
}

console.log('opencode mcp ok');

// The opencode brain's pieces that don't need the CLI running: its banner, model ids, tool names, and the
// message → event mapping the stream is built from. Run: npm test
import assert from 'node:assert/strict';
import { emitParts, modelId, modelRef, parseServerLine, pollMessages, stripToolPrefix } from '../opencode.mjs';

// `opencode serve` prints the port, then the password Basic auth needs.
assert.deepEqual(parseServerLine('server listening on http://127.0.0.1:4096'), { port: 4096 });
assert.deepEqual(parseServerLine('server password abc-_123'), { password: 'abc-_123' });
assert.equal(parseServerLine('some other log line'), null, 'nothing to read here');

// "provider/model"; a bare name falls to opencode's own provider, and an empty pick is no model at all.
assert.deepEqual(modelRef('ollama/qwen3.5:9b'), { providerID: 'ollama', id: 'qwen3.5:9b' }, 'the id keeps its own colons');
assert.deepEqual(modelRef('glm-5.3-flash-free'), { providerID: 'opencode', id: 'glm-5.3-flash-free' });
assert.equal(modelRef(''), null);
assert.equal(modelId({ providerID: 'opencode', id: 'x/y' }), 'opencode/x/y');

// opencode prefixes the tools it gets over MCP; ours are the bare names Roamies knows.
assert.equal(stripToolPrefix('mcp__roamies__read_file'), 'read_file');
assert.equal(stripToolPrefix('read_file'), 'read_file');

// Text and reasoning arrive as growing strings: the diff is what the UI and the voice get.
{
  const state = { text: '', reasoning: '', tools: new Map(), turns: 0, messageId: null };
  let out = emitParts(state, [{ type: 'text', text: 'Halo' }]);
  assert.deepEqual(out, [{ type: 'text_delta', text: 'Halo' }]);
  out = emitParts(state, [{ type: 'text', text: 'Halo, bos.' }]);
  assert.deepEqual(out, [{ type: 'text_delta', text: ', bos.' }], 'only the new part');
  assert.deepEqual(emitParts(state, [{ type: 'text', text: 'Halo, bos.' }]), [], 'nothing new, nothing said');
  assert.deepEqual(emitParts(state, [{ type: 'reasoning', text: 'Cek dulu.' }]), [{ type: 'thinking_delta', text: 'Cek dulu.' }], 'thinking streams too');

  // A tool call: starts once, ends once, under its bare name.
  const tool = (status, extra = {}) => ({ type: 'tool', id: 't1', name: 'mcp__roamies__read_file', state: { status, input: { path: '~/a.txt' }, ...extra } });
  assert.deepEqual(emitParts(state, [tool('running')]), [{ type: 'tool_call_start', toolCallId: 't1', name: 'read_file', args: { path: '~/a.txt' } }]);
  assert.deepEqual(emitParts(state, [tool('running')]), [], 'started only once');
  assert.deepEqual(emitParts(state, [tool('completed', { content: [{ type: 'text', text: 'pancake' }] })]),
    [{ type: 'tool_call_end', toolCallId: 't1', result: 'pancake', isError: false, durationMs: 0 }]);
  assert.deepEqual(emitParts(state, [tool('completed', { content: [] })]), [], 'ended only once');

  // A failed tool says so, and a streaming call waits for its input.
  const fail = { type: 'tool', id: 't2', name: 'run_command', state: { status: 'streaming', input: {} } };
  assert.equal(emitParts(state, [fail])[0].type, 'tool_call_start');
  assert.deepEqual(emitParts(state, [{ ...fail, state: { status: 'error', error: 'blocked' } }]),
    [{ type: 'tool_call_end', toolCallId: 't2', result: 'blocked', isError: true, durationMs: 0 }]);
}

// A poll of the message list diffs the newest assistant message, and starts over on a new one.
{
  const state = { text: '', reasoning: '', tools: new Map(), turns: 0, messageId: null };
  const listed = (id, text, completed) => ({ data: [
    { id: 'u1', type: 'user', text: 'hi' },
    { id, type: 'assistant', content: [{ type: 'text', text }], ...(completed ? { time: { created: 1, completed: 2 } } : {}) },
  ] });
  let r = pollMessages(state, listed('a1', 'Halo', false).data);
  assert.deepEqual(r.events, [{ type: 'text_delta', text: 'Halo' }]);
  assert.equal(r.done, false, 'still streaming');
  r = pollMessages(state, listed('a1', 'Halo, bos.', true).data);
  assert.deepEqual(r.events, [{ type: 'text_delta', text: ', bos.' }]);
  assert.equal(r.done, true, 'the message is completed');
  r = pollMessages(state, listed('a2', 'Lagi.', false).data);
  assert.deepEqual(r.events, [{ type: 'text_delta', text: 'Lagi.' }], 'a new message starts from its start');
  assert.deepEqual(pollMessages(state, [{ id: 'u1', type: 'user', text: 'hi' }]).events, [], 'no assistant message yet');
}

// A run that failed says why instead of looking like silence (a spent free limit, a bad key, a provider error).
{
  const state = { text: '', reasoning: '', tools: new Map(), turns: 0, messageId: null };
  const failed = [
    { id: 'u1', type: 'user', text: 'hi' },
    { id: 'a1', type: 'assistant', content: [], finish: 'error', error: { message: 'Free usage limit reached.' } },
    { id: 'i1', type: 'idle', outcome: 'failed', error: { message: 'Free usage limit reached.' } },
  ];
  assert.equal(pollMessages(state, failed).fail, 'Free usage limit reached.');
  assert.equal(pollMessages(state, [{ id: 'i1', type: 'idle', outcome: 'succeeded' }]).fail, null, 'a good run says nothing');
}

console.log('opencode ok');

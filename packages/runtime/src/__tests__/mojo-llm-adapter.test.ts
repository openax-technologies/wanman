import { afterEach, describe, expect, it } from 'vitest';
import { MojoLlmAdapter, spawnMojoLlmStub } from '../mojo-llm-adapter.js';
import type { AgentRunEvent } from '../agent-adapter.js';

afterEach(() => {
  delete process.env['MOJO_LLM_STUB_MODE'];
  delete process.env['MOJO_LLM_ENDPOINT'];
});

function makeOpts(initialMessage: string) {
  return {
    runtime: 'mojo_llm' as const,
    model: 'mojo-llm-31b',
    systemPrompt: 'You are a stub agent.',
    initialMessage,
    cwd: process.cwd(),
  };
}

async function collect(handle: ReturnType<typeof spawnMojoLlmStub>) {
  const events: AgentRunEvent[] = [];
  const results: Array<{ text: string; isError: boolean }> = [];
  handle.onEvent((e) => events.push(e));
  handle.onResult((text, isError) => results.push({ text, isError }));
  const exit = await handle.wait();
  return { events, results, exit };
}

describe('MojoLlmAdapter', () => {
  it('exposes runtime="mojo_llm"', () => {
    const adapter = new MojoLlmAdapter();
    expect(adapter.runtime).toBe('mojo_llm');
  });

  it('stub mode emits mojo_llm.stub.echo + turn.completed + exits 0', async () => {
    process.env['MOJO_LLM_STUB_MODE'] = '1';
    const handle = spawnMojoLlmStub(makeOpts('plan a release.'));
    const { events, results, exit } = await collect(handle);

    expect(exit).toBe(0);
    expect(events.some((e) => e.type === 'mojo_llm.stub.echo')).toBe(true);
    expect(events.some((e) => e.type === 'turn.completed')).toBe(true);
    expect(results.length).toBe(1);
    expect(results[0]?.isError).toBe(false);
    expect(results[0]?.text).toContain('plan a release.');
    expect(results[0]?.text).toContain('mojo-llm stub');
  });

  it('not-wired mode (no env) emits mojo_llm.not_wired + turn.failed + exits 1', async () => {
    const handle = spawnMojoLlmStub(makeOpts('do something.'));
    const { events, results, exit } = await collect(handle);

    expect(exit).toBe(1);
    expect(events.some((e) => e.type === 'mojo_llm.not_wired')).toBe(true);
    expect(events.some((e) => e.type === 'turn.failed')).toBe(true);
    expect(results.length).toBe(1);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.text).toMatch(/mojo-llm-adapter is a skeleton/);
  });

  it('endpoint-but-not-wired emits a different not_wired reason and exits 1', async () => {
    process.env['MOJO_LLM_ENDPOINT'] = 'https://mojo-llm.example.test/v1/chat';
    const handle = spawnMojoLlmStub(makeOpts('anything.'));
    const { events, results, exit } = await collect(handle);

    expect(exit).toBe(1);
    const notWired = events.find((e) => e.type === 'mojo_llm.not_wired');
    expect(notWired).toBeDefined();
    expect(notWired?.['endpoint']).toBe('https://mojo-llm.example.test/v1/chat');
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.text).toContain('endpoint is configured');
  });

  it('kill() terminates the subprocess and wait() resolves', async () => {
    process.env['MOJO_LLM_STUB_MODE'] = '1';
    const handle = spawnMojoLlmStub(makeOpts('long-running task.'));
    handle.kill();
    const exit = await handle.wait();
    // The stub exits quickly (0) on its own; kill() before completion
    // may still let it finish with 0, or may produce a signal-terminated
    // non-zero exit. Either is acceptable — we only assert wait() resolves.
    expect(typeof exit).toBe('number');
  });

  it('sendMessage() is a no-op (single-shot adapter)', async () => {
    process.env['MOJO_LLM_STUB_MODE'] = '1';
    const handle = spawnMojoLlmStub(makeOpts('one shot.'));
    // Should not throw.
    handle.sendMessage('post-hoc message');
    await handle.wait();
  });
});

import { spawn } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';
import { createLogger } from './logger.js';
import type {
  AgentAdapter,
  AgentRunEvent,
  AgentRunHandle,
  AgentRunOptions,
} from './agent-adapter.js';

/**
 * mojo-llm-adapter — wanman runtime adapter for the Mojo LLM 31B
 * inference base (Mojo Core's `engine.mojo_llm` slot; see Mojo Core
 * ADR 0002 and ADR 0004 §3-C).
 *
 * STATUS: skeleton. The adapter scaffolding ships so MojoClaw and
 * MojoAX can target `engine.mojo_llm` via the Mojo Core SDK and so
 * the wanman supervisor's runtime selector can dispatch to it
 * symmetrically with claude / codex. The actual inference path is
 * intentionally stubbed — there is no live Mojo LLM endpoint to call
 * yet. Wiring the real inference is tracked in Mojo Core ADR 0004
 * §"Status promotion path" and gated on a published model endpoint.
 *
 * Two operating modes:
 *
 *   1. `MOJO_LLM_STUB_MODE=1` (CI / vitest / offline demos):
 *      Emits a deterministic echo response and exits 0. Useful for
 *      cross-SDK behavior-parity tests and for proving the wanman
 *      supervisor can route to mojo_llm without a network call.
 *
 *   2. No `MOJO_LLM_STUB_MODE`, no `MOJO_LLM_ENDPOINT`: emits a
 *      typed `mojo_llm.not_wired` event with the wiring instructions
 *      and exits 1. This is the failure mode the user sees when
 *      `WANMAN_RUNTIME=mojo_llm` is set against a wanman build that
 *      doesn't yet have a live endpoint configured.
 *
 *   3. (Future) `MOJO_LLM_ENDPOINT=https://...` — the real inference
 *      path. Not implemented in this skeleton.
 *
 * The adapter spawns a tiny `node -e` subprocess to mirror the
 * `ChildProcess` lifecycle the AgentRunHandle contract expects. This
 * keeps the `kill()` / `wait()` / `.proc` semantics identical to
 * claude-adapter and codex-adapter — supervisors that already manage
 * processes (steer / SIGKILL / respawn) don't need a special case.
 */

const log = createLogger('mojo-llm-adapter');

interface MojoLlmStubScript {
  systemPrompt: string;
  initialMessage: string;
  endpoint?: string;
  stubMode: boolean;
}

function buildStubScript({
  systemPrompt,
  initialMessage,
  stubMode,
  endpoint,
}: MojoLlmStubScript): string {
  // The subprocess runs node with this script as `-e` payload. It writes
  // one JSON event per line to stdout, mirroring how codex-adapter's
  // subprocess does (`item.completed` / `turn.completed`). We use a
  // distinct `type` prefix (`mojo_llm.*`) so traces can filter on it.
  const payload = JSON.stringify({
    systemPrompt: systemPrompt.slice(0, 4000),
    initialMessage: initialMessage.slice(0, 4000),
  });
  if (stubMode) {
    return `
      const p = ${payload};
      console.log(JSON.stringify({
        type: 'mojo_llm.stub.echo',
        systemPromptPreview: p.systemPrompt.slice(0, 80),
        initialMessagePreview: p.initialMessage.slice(0, 80),
      }));
      console.log(JSON.stringify({
        type: 'turn.completed',
        text: '[mojo-llm stub] would have asked Mojo LLM 31B to handle: ' + p.initialMessage,
      }));
      process.exit(0);
    `;
  }
  if (endpoint) {
    // Future hook: replace this with a real fetch to the Mojo LLM
    // endpoint. For now we emit a "not_wired" event with the
    // endpoint that would have been called.
    return `
      const p = ${payload};
      console.log(JSON.stringify({
        type: 'mojo_llm.not_wired',
        reason: 'endpoint set but adapter implementation pending',
        endpoint: ${JSON.stringify(endpoint)},
      }));
      console.log(JSON.stringify({
        type: 'turn.failed',
        error: 'Mojo LLM endpoint is configured (${endpoint}) but mojo-llm-adapter has no live inference path yet. See Mojo Core ADR 0004 §3-C.',
      }));
      process.exit(1);
    `;
  }
  return `
    console.log(JSON.stringify({
      type: 'mojo_llm.not_wired',
      reason: 'no MOJO_LLM_ENDPOINT and no MOJO_LLM_STUB_MODE=1',
      docs: 'See Mojo Core ADR 0004 \\u00a73-C for wiring instructions.',
    }));
    console.log(JSON.stringify({
      type: 'turn.failed',
      error: 'mojo-llm-adapter is a skeleton. Set MOJO_LLM_STUB_MODE=1 for a deterministic echo (CI), or MOJO_LLM_ENDPOINT=... once a live endpoint exists.',
    }));
    process.exit(1);
  `;
}

function pickString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = pickString(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['text', 'output_text', 'message', 'content']) {
    const found = pickString(record[key]);
    if (found) return found;
  }
  return null;
}

interface MojoLlmResult {
  text: string;
  isError: boolean;
}

function extractResult(event: AgentRunEvent): MojoLlmResult | null {
  if (event.type === 'turn.failed') {
    const text = pickString(event['error']) || pickString(event) || 'Mojo LLM turn failed';
    return { text, isError: true };
  }
  if (event.type === 'turn.completed') {
    const text = pickString(event);
    if (text) return { text, isError: false };
  }
  return null;
}

export function spawnMojoLlmStub(opts: AgentRunOptions): AgentRunHandle {
  const stubMode = process.env['MOJO_LLM_STUB_MODE'] === '1';
  const endpoint = process.env['MOJO_LLM_ENDPOINT'];

  const script = buildStubScript({
    systemPrompt: opts.systemPrompt,
    initialMessage: opts.initialMessage ?? '',
    stubMode,
    endpoint,
  });

  log.info('spawning', {
    runtime: 'mojo_llm',
    cwd: opts.cwd,
    mode: stubMode ? 'stub' : endpoint ? 'endpoint_configured_but_not_wired' : 'not_wired',
    ...(endpoint ? { endpoint } : {}),
  });

  const proc = spawn(process.execPath, ['-e', script], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      ...opts.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const eventHandlers: Array<(event: AgentRunEvent) => void> = [];
  const resultHandlers: Array<(result: string, isError: boolean) => void> = [];
  const exitHandlers: Array<(code: number) => void> = [];
  let rl: ReadlineInterface | null = null;

  if (proc.stdout) {
    rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line.trim()) as AgentRunEvent;
        for (const handler of eventHandlers) handler(event);
        const result = extractResult(event);
        if (result) {
          for (const handler of resultHandlers) handler(result.text, result.isError);
        }
      } catch {
        // Non-JSON stdout line; ignore.
      }
    });
  }

  if (proc.stderr) {
    proc.stderr.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text) log.warn('stderr', { text: text.slice(0, 500) });
    });
  }

  proc.on('error', (err) => {
    log.error('spawn error', { error: err.message });
    for (const handler of exitHandlers) handler(1);
  });

  proc.on('close', (code) => {
    rl?.close();
    const exitCode = code ?? 1;
    log.info('exited', { code: exitCode });
    for (const handler of exitHandlers) handler(exitCode);
  });

  return {
    proc,
    sendMessage(): void {
      // Single-shot; steer is handled by kill + respawn at AgentProcess level.
    },
    kill(): void {
      if (!proc.killed) {
        log.info('killing process');
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 5000);
      }
    },
    wait(): Promise<number> {
      return new Promise((resolve) => {
        if (proc.exitCode !== null) {
          resolve(proc.exitCode);
          return;
        }
        proc.on('close', (code) => resolve(code ?? 1));
        proc.on('error', () => resolve(1));
      });
    },
    onEvent(handler) { eventHandlers.push(handler); },
    onResult(handler) { resultHandlers.push(handler); },
    onExit(handler) { exitHandlers.push(handler); },
  };
}

export class MojoLlmAdapter implements AgentAdapter {
  readonly runtime = 'mojo_llm' as const;

  startRun(opts: AgentRunOptions): AgentRunHandle {
    return spawnMojoLlmStub(opts);
  }
}

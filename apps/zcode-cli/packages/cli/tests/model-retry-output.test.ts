import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { RunContext } from "@zcode/shared-types";
import { run, type RunDependencies } from "../src/run.js";
import { createModelRetryReporter } from "../src/model-retry-output.js";

const status = (type: string, extra: Record<string, unknown> = {}): SessionEvent =>
  ({
    id: `${type}-${extra.requestId ?? "request-1"}-${extra.attempt ?? 1}`,
    type: SessionEventType.ModelNetworkStatus,
    sessionId: "session-test",
    turnId: "turn-test",
    payload: {
      type,
      requestId: "request-1",
      attempt: 1,
      maxAttempts: 3,
      providerId: "provider",
      modelId: "model",
      spanId: "model-call-1",
      nextAttempt: 2,
      delayMs: 1854,
      statusCode: 429,
      reason: "rate_limited",
      message: "SENSITIVE provider payload",
      responseHeaders: { cookie: "SENSITIVE" },
      ...extra,
    },
  }) as SessionEvent;

const capture = () => {
  let output = "";
  return {
    write: (chunk: string) => {
      output += chunk;
      return true;
    },
    output: () => output,
  };
};

const fixture = (
  events: SessionEvent[],
  subscribed: boolean,
  args: string[] = [],
  fail = false,
) => {
  const stdout = capture();
  const stderr = capture();
  let sink: ((event: SessionEvent) => void) | undefined;
  let detachCount = 0;
  let fallbackUsed = false;
  const ctx = {
    argv: ["-p", "hello", ...args],
    stdout,
    stderr,
    stdin: { isTTY: false },
  } as unknown as RunContext;
  const deps: RunDependencies = {
    loadDotenv: () => ({ keys: [], loaded: false }),
    startProcessProviderRegistryRuntime: async () =>
      ({ dispose() {}, runtime: { registryService: {} } }) as never,
    mapSessionEvent: ((event: SessionEvent) => ({ eventId: event.id, type: event.type })) as never,
    createZCodeApp: () =>
      ({
        sessionId: "session-test",
        traceId: "trace-test",
        getModel: () => "provider/model",
        getThoughtLevel: () => "medium",
        runtime: subscribed
          ? {
              subscribeEvents: (target: { onSessionEvent: (event: SessionEvent) => void }) => {
                sink = target.onSessionEvent;
                return () => {
                  detachCount++;
                  sink = undefined;
                };
              },
            }
          : {},
        submitPrompt: async (
          _prompt: unknown,
          options?: { onEvent?: (event: SessionEvent) => void },
        ) => {
          fallbackUsed = options?.onEvent !== undefined;
          for (const event of events) {
            sink?.(event);
            options?.onEvent?.(event);
          }
          // Check status is visible before submitPrompt resolves.
          if (args.length === 0) assert.match(stderr.output(), /Retry 1\/2 in 2s \(HTTP 429\)/);
          if (fail) throw new Error("Request failed after retries");
          return {
            events,
            response: "the answer",
            traceId: "trace-test",
            turnId: "turn-test",
            projection: {
              status: "idle",
              contextUsed: 0,
              contextWindow: 1000,
              totalTokenCount: 0,
              turnCount: 1,
            },
          };
        },
      }) as never,
  };
  return {
    ctx,
    deps,
    stdout,
    stderr,
    detachCount: () => detachCount,
    fallbackUsed: () => fallbackUsed,
  };
};

for (const subscribed of [false, true]) {
  test(`text retry status uses ${subscribed ? "subscription" : "fallback"} once and recovers only on completion`, async () => {
    const events = [
      status("model_retry_scheduled"),
      status("model_retry_scheduled"),
      status("model_request_started", { attempt: 2, requestId: "request-2" }),
      status("model_request_completed", {
        attempt: 2,
        requestId: "unrelated",
        spanId: "other-call",
      }),
      status("model_request_completed", { attempt: 2, requestId: "request-2" }),
      status("model_request_completed", { attempt: 2, requestId: "request-2" }),
    ];
    const f = fixture(events, subscribed);
    assert.equal(await run(f.ctx, f.deps), 0);
    assert.equal(f.stdout.output(), "the answer\n");
    assert.equal(f.stderr.output(), "Retry 1/2 in 2s (HTTP 429).\nModel request recovered.\n");
    assert.equal(f.detachCount(), Number(subscribed));
    assert.equal(f.fallbackUsed(), !subscribed);
  });
}

test("a new attempt and final failure never report recovery", async () => {
  const f = fixture(
    [
      status("model_retry_scheduled"),
      status("model_request_started", { attempt: 2 }),
      status("model_request_failed", { attempt: 2, retryable: false }),
    ],
    true,
    [],
    true,
  );
  assert.equal(await run(f.ctx, f.deps), 1);
  assert.equal(f.stdout.output(), "");
  assert.match(f.stderr.output(), /Request failed after retries/);
  assert.doesNotMatch(f.stderr.output(), /recovered|SENSITIVE/);
  assert.equal(f.detachCount(), 1);
});

for (const args of [["--json"], ["--output-format", "json"], ["--output-format", "stream-json"]]) {
  test(`${args.join(" ")} keeps terminal retry status silent`, async () => {
    const f = fixture(
      [status("model_retry_scheduled"), status("model_request_completed", { attempt: 2 })],
      true,
      args,
    );
    assert.equal(await run(f.ctx, f.deps), 0);
    assert.equal(f.stderr.output(), "");
    const lines = f.stdout.output().trim().split("\n");
    const result = args.includes("stream-json")
      ? JSON.parse(lines.at(-1)!)
      : JSON.parse(f.stdout.output());
    assert.equal(result.response, "the answer");
  });
}

test("safe classified reasons replace raw messages and unknown reason text", async () => {
  const f = fixture(
    [
      status("model_retry_scheduled"),
      status("model_retry_scheduled", {
        requestId: "network",
        statusCode: undefined,
        reason: "network_error",
        nextAttempt: 3,
        delayMs: 2000,
      }),
      status("model_retry_scheduled", {
        requestId: "unknown",
        statusCode: undefined,
        reason: "SENSITIVE",
        maxAttempts: 0,
        nextAttempt: 4,
        delayMs: 0,
      }),
    ],
    false,
  );
  assert.equal(await run(f.ctx, f.deps), 0);
  assert.match(f.stderr.output(), /Retry 2\/2 in 2s \(network error\)/);
  assert.match(f.stderr.output(), /Retry 3\/unlimited in 0s \(temporary error\)/);
  assert.doesNotMatch(f.stderr.output(), /SENSITIVE|recovered/);
});

test("only known reasons and valid HTTP status codes reach terminal output", () => {
  const output = capture();
  const report = createModelRetryReporter(output.write);
  report(status("model_retry_scheduled", { statusCode: undefined, reason: "timeout" }));
  report(status("model_request_started", { attempt: 2, requestId: "second-attempt" }));
  assert.equal(output.output(), "Retry 1/2 in 2s (request timeout).\n");
  report(
    status("model_retry_scheduled", { requestId: "third", statusCode: 700, reason: "constructor" }),
  );
  assert.match(output.output(), /\(temporary error\)/);
  assert.doesNotMatch(output.output(), /function|HTTP 700|recovered/);
});

test("an exhausted failed request cannot recover through a later model call", () => {
  const output = capture();
  const report = createModelRetryReporter(output.write);
  report(status("model_retry_scheduled"));
  report(status("model_request_failed", { attempt: 3, retryable: true }));
  report(status("model_request_completed", { attempt: 3, requestId: "later" }));
  assert.doesNotMatch(output.output(), /recovered/);
});

test("off-peak queue probes recover without increasing the retry budget attempt", () => {
  const output = capture();
  const report = createModelRetryReporter(output.write);
  report(status("model_retry_scheduled", { reason: "offpeak_queued", delayMs: 60_000 }));
  report(status("model_request_started", { requestId: "queue-probe", attempt: 1 }));
  assert.doesNotMatch(output.output(), /recovered/);
  report(status("model_request_completed", { requestId: "queue-probe", attempt: 1 }));
  report(status("model_request_completed", { requestId: "queue-probe", attempt: 1 }));
  assert.equal(output.output(), "Retry 1/2 in 60s (HTTP 429).\nModel request recovered.\n");
});

test("explicit text format overrides the legacy JSON flag for retry output", async () => {
  const f = fixture([status("model_retry_scheduled")], false, [
    "--json",
    "--output-format",
    "text",
  ]);
  assert.equal(await run(f.ctx, f.deps), 0);
  assert.equal(f.stdout.output(), "the answer\n");
  assert.equal(f.stderr.output(), "Retry 1/2 in 2s (HTTP 429).\n");
});

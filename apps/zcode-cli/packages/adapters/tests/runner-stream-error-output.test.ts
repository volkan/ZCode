import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelNetworkStatusEvent, ModelStreamEvent } from "@zcode/contracts";
import { executeAdapterStreamText } from "./test-adapter-model.js";
import { TestAiSdkModelAdapter, TestProviderConfigFixture } from "./test-provider-config.js";

const MAX_ATTEMPTS = 2;
const BAD_GATEWAY = 502;
const EVENT_STREAM_HEADERS = { "content-type": "text/event-stream" };

function successfulResponse(): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: "message-fixture",
        type: "message",
        role: "assistant",
        model: "fixture-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: EVENT_STREAM_HEADERS },
  );
}

function harness() {
  const status: ModelNetworkStatusEvent[] = [];
  const adapter = new TestAiSdkModelAdapter({
    env: { ZCODE_RUNTIME_ENV: "test" },
    registry: new TestProviderConfigFixture({
      providers: {
        fixture: {
          apiKey: "fixture-key",
          baseURL: "https://provider.example.test/anthropic",
          kind: "anthropic",
        },
      },
    }),
    retry: { baseDelayMs: 0, jitter: false, maxAttempts: MAX_ATTEMPTS },
  });
  const read = async () => {
    const events: ModelStreamEvent[] = [];
    for await (const event of executeAdapterStreamText(adapter, {
      providerId: "fixture" as never,
      modelId: "fixture-model" as never,
      messages: [{ role: "user", content: "Reply ok" }],
      statusSink: {
        publish: (event) => void status.push(event),
      },
    })) {
      events.push(event);
    }
    return events;
  };
  return { read, status };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("real AI SDK stream error output", () => {
  it("retries HTTP 502 without printing the SDK error object", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: BAD_GATEWAY,
          statusText: "Bad Gateway",
          headers: { "set-cookie": "fixture-cookie=private" },
        }),
      )
      .mockImplementation(async () => successfulResponse());
    vi.stubGlobal("fetch", fetch);
    const run = harness();

    const events = await run.read();

    expect(fetch).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", text: "ok" }));
    expect(run.status).toContainEqual(
      expect.objectContaining({
        type: "model_retry_scheduled",
        nextAttempt: 2,
        statusCode: BAD_GATEWAY,
      }),
    );
    expect(run.status).toContainEqual(
      expect.objectContaining({ type: "model_request_completed", attempt: 2 }),
    );
    expect(stderr).not.toHaveBeenCalled();
  });

  it("preserves final failure and retry diagnostics without printing raw errors", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status: BAD_GATEWAY, statusText: "Bad Gateway" }),
    );
    vi.stubGlobal("fetch", fetch);
    const run = harness();

    await expect(run.read()).rejects.toMatchObject({
      context: { statusCode: BAD_GATEWAY, attempt: MAX_ATTEMPTS },
    });

    expect(fetch).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(run.status.filter((event) => event.type === "model_retry_scheduled")).toHaveLength(1);
    expect(run.status).toContainEqual(
      expect.objectContaining({
        type: "model_request_failed",
        attempt: MAX_ATTEMPTS,
        statusCode: BAD_GATEWAY,
      }),
    );
    expect(run.status.some((event) => event.type === "model_request_completed")).toBe(false);
    expect(stderr).not.toHaveBeenCalled();
  });
});

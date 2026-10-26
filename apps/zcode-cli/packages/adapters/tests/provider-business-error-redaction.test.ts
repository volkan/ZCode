import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { classifyModelFailure } from "../src/model/failure-classifier.js";
import {
  createProviderBusinessErrorFetch,
  ProviderBusinessError,
} from "../src/model/model-execution.js";
import { detectProviderBusinessFinishError } from "../src/model/provider-finish-business-error.js";

const provider = { providerId: "CANARY-provider", providerKind: "openai-compatible" as const };
const sensitiveHeaders = {
  "SeT-CoOkIe": "CANARY_COOKIE",
  aUtHoRiZaTiOn: "Bearer CANARY_AUTHORIZATION",
  "X-aPi-KeY": "CANARY_API_KEY",
};

function expectPrivate(error: ProviderBusinessError): void {
  for (const output of [inspect(error), JSON.stringify(error)]) {
    for (const value of Object.values(sensitiveHeaders)) {
      expect(output).not.toContain(value);
    }
  }
  expect(error.responseHeaders).toMatchObject({
    "set-cookie": "[redacted]",
    authorization: "[redacted]",
    "x-api-key": "[redacted]",
  });
}

describe("ProviderBusinessError response header privacy", () => {
  it.each([
    [{ "ReTrY-AfTeR": "41" }, 41_000],
    [{ "ReTrY-AfTeR": "41", "Retry-After-Ms": "1200" }, 1200],
    [{ "ReTrY-AfTeR": "41", "X-ShOuLd-ReTrY": "FaLsE" }, undefined],
    [{ "Retry-After-Ms": "1200", "X-ShOuLd-ReTrY": "0" }, undefined],
  ])("redacts inspection and JSON while preserving retry semantics: %j", (retryHeaders, delay) => {
    const headers = Object.freeze({ ...sensitiveHeaders, ...retryHeaders });
    const before = { ...headers };
    const error = new ProviderBusinessError({
      ...provider,
      providerCode: "1302",
      statusCode: 429,
      responseStatus: 429,
      responseHeaders: headers,
    });

    expectPrivate(error);
    expect(error).toMatchObject({ providerCode: "1302", statusCode: 429, responseStatus: 429 });
    expect(classifyModelFailure(error)).toMatchObject({
      retryAfterMs: delay,
      retryable: true,
      statusCode: 429,
    });
    for (const [name, value] of Object.entries(retryHeaders)) {
      expect(error.responseHeaders?.[name.toLowerCase()]).toBe(value);
    }
    expect(error.responseHeaders).not.toBe(headers);
    expect(headers).toEqual(before);
  });

  it("preserves undefined and empty headers", () => {
    expect(new ProviderBusinessError(provider).responseHeaders).toBeUndefined();
    expect(new ProviderBusinessError({ ...provider, responseHeaders: {} }).responseHeaders).toEqual(
      {},
    );
  });

  it.each(["direct", "nested"])(
    "protects raw %s finish records without retaining their body",
    (kind) => {
      const headers = Object.freeze({ ...sensitiveHeaders, "Retry-After": "41" });
      const payload = {
        code: "1308",
        message: "CANARY rate limit",
        responseHeaders: headers,
        statusCode: 429,
      };
      const source =
        kind === "direct" ? { type: "finish", ...payload } : { type: "error", error: payload };
      const error = detectProviderBusinessFinishError({ ...provider, source });
      expect(error).toBeInstanceOf(ProviderBusinessError);
      if (!error) throw new Error("Expected finish error");
      expectPrivate(error);
      expect(error).toMatchObject({ providerCode: "1308", statusCode: 429 });
      expect(classifyModelFailure(error).retryAfterMs).toBe(41_000);
      expect(error.responseBodySummary).not.toBe(source);
      expect(headers["SeT-CoOkIe"]).toBe("CANARY_COOKIE");
    },
  );

  it("protects mocked fetch errors and their finish reconstruction", async () => {
    const response = Response.json(
      { error: { code: "1302", message: "CANARY rate limit" } },
      {
        status: 429,
        headers: { ...sensitiveHeaders, "Retry-After": "41", "Retry-After-Ms": "1200" },
      },
    );
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response);
    const fetchBusinessError = createProviderBusinessErrorFetch({
      ...provider,
      env: {},
      fetch: transport,
    });
    const error = await fetchBusinessError("https://canary.invalid/model").catch(
      (cause: unknown) => cause,
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(ProviderBusinessError);
    if (!(error instanceof ProviderBusinessError)) throw new Error("Expected business error");
    expectPrivate(error);
    expect(error).toMatchObject({ providerCode: "1302", responseStatus: 429 });
    expect(response.bodyUsed).toBe(true);

    const reconstructed = detectProviderBusinessFinishError({
      ...provider,
      source: { type: "error", error },
    });
    expect(reconstructed).toBeInstanceOf(ProviderBusinessError);
    if (!reconstructed) throw new Error("Expected reconstructed business error");
    expectPrivate(reconstructed);
    expect(reconstructed).toMatchObject({ providerCode: "1302", responseStatus: 429 });
    expect(reconstructed.responseHeaders).toMatchObject({
      "retry-after": "41",
      "retry-after-ms": "1200",
    });
    expect(classifyModelFailure(reconstructed).retryAfterMs).toBe(1200);
  });
});

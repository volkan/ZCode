import {
  SessionEventType,
  type ModelNetworkStatusEvent,
  type SessionEvent,
} from "@zcode/contracts";

const MILLISECONDS_PER_SECOND = 1000;
const UNBOUNDED_ATTEMPTS = 0;
const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 599;
const RECOVERY_LINE = "Model request recovered.\n";
const RETRY_REASONS: Readonly<Record<string, string>> = {
  rate_limited: "rate limited",
  provider_overloaded: "provider busy",
  server_error: "server error",
  network_error: "network error",
  timeout: "request timeout",
  stream_idle_timeout: "stream timeout",
  stale_connection: "connection interrupted",
  auth_refresh: "refreshing authentication",
  reasoning_signature_repair: "repairing request history",
  offpeak_queued: "waiting for provider capacity",
};

// 物理重试会更换 requestId；同一 model call 的稳定标识才能关联真正成功，避免把 started 当作恢复。
const callKey = (event: SessionEvent, status: ModelNetworkStatusEvent): string =>
  JSON.stringify([
    event.sessionId,
    event.turnId ?? status.turnId,
    status.queryId,
    status.toolCallId,
    status.modelCall?.operationId ?? status.spanId,
    status.querySource,
    status.modelCall?.stepIndex,
    status.providerId,
    status.modelId,
  ]);

export const createModelRetryReporter = (write: (line: string) => void) => {
  const pending = new Map<
    string,
    { requestId: string; nextAttempt: number; minimumCompletionAttempt: number }
  >();
  return (event: SessionEvent): void => {
    if (event.type !== SessionEventType.ModelNetworkStatus) return;
    const status = event.payload as ModelNetworkStatusEvent;
    const key = callKey(event, status);
    if (status.type === "model_retry_scheduled") {
      const previous = pending.get(key);
      if (previous?.requestId === status.requestId && previous.nextAttempt === status.nextAttempt)
        return;
      pending.set(key, {
        requestId: status.requestId,
        nextAttempt: status.nextAttempt,
        // 错峰排队不增加 attempt；恢复判断必须允许相同计数。
        minimumCompletionAttempt:
          status.reason === "offpeak_queued" ? status.attempt : status.nextAttempt,
      });
      const limit =
        status.maxAttempts === UNBOUNDED_ATTEMPTS
          ? "unlimited"
          : String(Math.max(0, status.maxAttempts - 1));
      const seconds = Math.ceil(status.delayMs / MILLISECONDS_PER_SECOND);
      const reason =
        Number.isInteger(status.statusCode) &&
        status.statusCode! >= MIN_HTTP_STATUS &&
        status.statusCode! <= MAX_HTTP_STATUS
          ? `HTTP ${status.statusCode}`
          : Object.hasOwn(RETRY_REASONS, status.reason)
            ? RETRY_REASONS[status.reason]
            : "temporary error";
      write(`Retry ${status.nextAttempt - 1}/${limit} in ${seconds}s (${reason}).\n`);
    } else if (status.type === "model_request_completed") {
      const retry = pending.get(key);
      if (!retry || status.attempt < retry.minimumCompletionAttempt) return;
      pending.delete(key);
      write(RECOVERY_LINE);
    } else if (
      status.type === "model_request_failed" &&
      (!status.retryable ||
        (status.maxAttempts > UNBOUNDED_ATTEMPTS && status.attempt >= status.maxAttempts))
    ) {
      pending.delete(key);
    } else if (
      status.type === "model_request_started" &&
      status.attempt === 1 &&
      pending.get(key)?.minimumCompletionAttempt !== status.attempt
    ) {
      pending.delete(key);
    }
  };
};

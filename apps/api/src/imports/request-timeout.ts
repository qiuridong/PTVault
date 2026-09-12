export type BoundedRequestSignal = {
  signal: AbortSignal;
  dispose(): void;
};

/**
 * Gives every provider request a local deadline while preserving an upstream
 * shutdown/cancel signal. The timer stays alive until the response body is
 * consumed, because fetch resolving headers is not proof that the body cannot
 * stall.
 */
export function createBoundedRequestSignal(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
): BoundedRequestSignal {
  const controller = new AbortController();
  const forwardAbort = (): void => {
    controller.abort(
      upstream?.reason instanceof Error ? upstream.reason : new Error('request aborted'),
    );
  };
  if (upstream?.aborted) forwardAbort();
  else upstream?.addEventListener('abort', forwardAbort, { once: true });

  const timer = setTimeout(() => controller.abort(new Error('request timed out')), timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      upstream?.removeEventListener('abort', forwardAbort);
    },
  };
}

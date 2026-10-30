import { expect, it, vi } from "vite-plus/test";
import * as RequestLatency from "./requestLatencyState";

it("warns after 60 seconds and clears the warning when the request completes", () => {
  vi.useFakeTimers();
  const listener = vi.fn();
  const unsubscribe = RequestLatency.subscribeSlowRpcAckRequests(listener);
  try {
    RequestLatency.trackRpcRequestSent("slow-request", "vcs.getDiffPreview");
    vi.advanceTimersByTime(59_999);
    expect(listener.mock.calls.flatMap(([requests]) => requests)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenLastCalledWith([
      expect.objectContaining({ requestId: "slow-request", thresholdMs: 60_000 }),
    ]);
    RequestLatency.acknowledgeRpcRequest("slow-request");
    expect(listener).toHaveBeenLastCalledWith([]);
  } finally {
    RequestLatency.acknowledgeRpcRequest("slow-request");
    unsubscribe();
    vi.useRealTimers();
  }
});

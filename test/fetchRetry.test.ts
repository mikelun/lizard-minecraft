import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "../src/world/fetchRetry";

afterEach(() => vi.unstubAllGlobals());

describe("fetchWithRetry", () => {
  it("retries a failed response, then returns the first ok one", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const res = await fetchWithRetry("/x", 3, 1);
    expect(await res.text()).toBe("ok");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("throws the last error after all attempts", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchWithRetry("/x", 2, 1)).rejects.toThrow("HTTP 404");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it } from "vitest";
import { sanitizeInheritedPaperclipEnv, revalidateInheritedPaperclipApiUrl } from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });
});

describe("revalidateInheritedPaperclipApiUrl", () => {
  it("returns env unchanged when PAPERCLIP_API_URL is absent", async () => {
    const env: Record<string, string> = { PATH: "/usr/bin" };
    const result = await revalidateInheritedPaperclipApiUrl(env);
    expect(result).toEqual({ PATH: "/usr/bin" });
  });

  it("returns env unchanged when PAPERCLIP_API_URL is a reachable loopback URL", async () => {
    // localhost:3100 is the server port — it is always listening in this environment.
    const env: Record<string, string> = {
      PAPERCLIP_API_URL: "http://localhost:3100",
      PAPERCLIP_LISTEN_PORT: "3100",
      PATH: "/usr/bin",
    };
    const result = await revalidateInheritedPaperclipApiUrl(env);
    expect(result.PAPERCLIP_API_URL).toBe("http://localhost:3100");
    expect(result.PAPERCLIP_LISTEN_PORT).toBe("3100"); // unchanged
  });

  it("replaces unreachable loopback URL with fallback derived from LISTEN_PORT", async () => {
    // Port 59999 is never in use; connection is refused immediately.
    const env: Record<string, string> = {
      PAPERCLIP_API_URL: "http://localhost:59999",
      PAPERCLIP_LISTEN_PORT: "3100",
      PATH: "/usr/bin",
    };
    const result = await revalidateInheritedPaperclipApiUrl(env);
    expect(result.PAPERCLIP_API_URL).toBe("http://localhost:3100");
    expect(result.PAPERCLIP_LISTEN_PORT).toBe("3100"); // untouched
  });

  it("replaces unreachable 127.0.0.1 URL with fallback using default port 3100", async () => {
    const env: Record<string, string> = {
      PAPERCLIP_API_URL: "http://127.0.0.1:59999",
    };
    const result = await revalidateInheritedPaperclipApiUrl(env);
    expect(result.PAPERCLIP_API_URL).toBe("http://localhost:3100");
  });

  it("leaves non-loopback URLs untouched", async () => {
    const env: Record<string, string> = {
      PAPERCLIP_API_URL: "http://192.168.1.100:3100",
    };
    const result = await revalidateInheritedPaperclipApiUrl(env);
    expect(result.PAPERCLIP_API_URL).toBe("http://192.168.1.100:3100");
  });

  it("uses PAPERCLIP_LISTEN_PORT for fallback when present", async () => {
    const env: Record<string, string> = {
      PAPERCLIP_API_URL: "http://localhost:59999",
      PAPERCLIP_LISTEN_PORT: "5432",
    };
    const result = await revalidateInheritedPaperclipApiUrl(env);
    expect(result.PAPERCLIP_API_URL).toBe("http://localhost:5432");
  });
});

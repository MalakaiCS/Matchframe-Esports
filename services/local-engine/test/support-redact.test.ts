import { describe, expect, it } from "vitest";
import { redactSupport, textScrubber } from "../src/support-redact.ts";

describe("support file redaction (ADR-077)", () => {
  const operator = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const device = "mfd_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-xyz";

  it("removes secret-looking keys at any depth, and leaves the rest", () => {
    const out = redactSupport({
      app: { version: "0.12.4" },
      obs: { host: "127.0.0.1", password: "hunter2", websocketVersion: "5.5" },
      cloud: { apiKey: "sk_live_1", api_key: "x", privateKey: "y", signingKey: "z", accessKey: "a", streamKey: "b", publicKeys: { k1: "PUBLIC" } },
      deep: [{ a: { b: { authorization: "Bearer zzz", cookie: "mf_session=1" } } }],
      counts: [1, 2, 3],
      ok: true,
    });
    expect(out).toEqual({
      app: { version: "0.12.4" },
      obs: { host: "127.0.0.1", password: "[redacted]", websocketVersion: "5.5" },
      cloud: { apiKey: "[redacted]", api_key: "[redacted]", privateKey: "[redacted]", signingKey: "[redacted]", accessKey: "[redacted]", streamKey: "[redacted]", publicKeys: { k1: "PUBLIC" } },
      deep: [{ a: { b: { authorization: "[redacted]", cookie: "[redacted]" } } }],
      counts: [1, 2, 3],
      ok: true,
    });
  });

  it("scrubs secrets written into text: headers, addresses, key=value, device credentials and access tokens", () => {
    const scrub = textScrubber();
    expect(scrub("GET failed: Authorization: Bearer abcdefgh12345678")).toBe("GET failed: Authorization: Bearer [redacted]");
    expect(scrub("overlay http://127.0.0.1:37212/overlay/main/live?t=s3cr3t&x=1 and /captain?token=abc#t=zz")).toBe("overlay http://127.0.0.1:37212/overlay/main/live?t=[redacted]&x=1 and /captain?token=[redacted]#t=[redacted]");
    expect(scrub("connect rtmp://user:pa55@live.example.com/app")).toBe("connect rtmp://[redacted]@live.example.com/app");
    expect(scrub('saving {"password":"hunter22","name":"OBS"} and stream_key=live_abc123')).toBe('saving {"password":"[redacted]","name":"OBS"} and stream_key=[redacted]');
    expect(scrub(`signed in with ${device}`)).toBe("signed in with mfd_[redacted]");
    expect(scrub(`role token ${operator} issued`)).toBe("role token [redacted] issued");
    expect(scrub("-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----")).toBe("[redacted] private key");
    // A SHA-256 is not a token.
    const sha = "a".repeat(64);
    expect(scrub(`demo ${sha}`)).toBe(`demo ${sha}`);
    expect(scrub("the GSI token was refused; 3 tokens issued")).toBe("the GSI token was refused; 3 tokens issued");
  });

  it("removes every secret the caller knows word for word, and the home folder from paths", () => {
    const out = redactSupport(
      { logs: [{ msg: "OBS refused password Tr0ub4dor&3 at C:\\Users\\Alex\\AppData\\Roaming\\MatchFrame Esports" }, { msg: "c:/users/alex/Videos/MatchFrame Highlights; C:\\Users\\Alexander stays" }], short: "abc" },
      { secrets: ["Tr0ub4dor&3", "abc", null, undefined], home: "C:\\Users\\Alex" },
    );
    expect(out).toEqual({ logs: [{ msg: "OBS refused password [redacted] at ~\\AppData\\Roaming\\MatchFrame Esports" }, { msg: "~/Videos/MatchFrame Highlights; C:\\Users\\Alexander stays" }], short: "abc" });
    expect(redactSupport({ p: "/home/alex/.config and /home/alexander" }, { home: "/home/alex" })).toEqual({ p: "~/.config and /home/alexander" });
  });

  it("cuts values nested deeper than the limit", () => {
    expect(redactSupport({ a: { b: { c: "x" } } }, { maxDepth: 2 })).toEqual({ a: { b: "[depth]" } });
  });
});

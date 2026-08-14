import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  CodexRuntimeManager,
  codexRuntimeKey,
  normalizeCodexRuntimeMode,
} from "./codex-runtime-manager.mjs";

function identity(owner = "admin", server = "server-91") {
  return {
    owner,
    connectionProfileId: server,
    remoteHostFingerprint: `fingerprint-${server}`,
    codexHomeNamespace: `cozypad-${owner}`,
  };
}

function mockTransport() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  let input = "";
  child.stdin.on("data", (chunk) => {
    input += chunk.toString("utf8");
    for (;;) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      const request = JSON.parse(input.slice(0, newline));
      input = input.slice(newline + 1);
      if (request.method === "initialize") {
        child.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: "mock" } })}\n`);
      }
    }
  });
  return child;
}

describe("CodexRuntimeManager", () => {
  it("defaults unknown feature flag values to legacy", () => {
    expect(normalizeCodexRuntimeMode("app-server")).toBe("app-server");
    expect(normalizeCodexRuntimeMode("auto")).toBe("auto");
    expect(normalizeCodexRuntimeMode("anything-else")).toBe("legacy");
  });

  it("single-flights the same owner and server runtime", async () => {
    const startTransport = vi.fn(async () => mockTransport());
    const manager = new CodexRuntimeManager({ mode: "app-server", startTransport });

    const [first, second] = await Promise.all([
      manager.acquire(identity()),
      manager.acquire(identity()),
    ]);

    expect(first).toBe(second);
    expect(startTransport).toHaveBeenCalledTimes(1);
    expect(first.status).toBe("ready");
    manager.shutdown();
  });

  it("keeps a burst of callers on one transport", async () => {
    const startTransport = vi.fn(async () => mockTransport());
    const manager = new CodexRuntimeManager({ mode: "app-server", startTransport });

    const runtimes = await Promise.all(
      Array.from({ length: 100 }, () => manager.acquire(identity())),
    );

    expect(new Set(runtimes).size).toBe(1);
    expect(startTransport).toHaveBeenCalledTimes(1);
    manager.shutdown();
  });

  it("isolates runtimes by owner", async () => {
    const startTransport = vi.fn(async () => mockTransport());
    const manager = new CodexRuntimeManager({ mode: "app-server", startTransport });

    const admin = await manager.acquire(identity("admin"));
    const alice = await manager.acquire(identity("alice"));

    expect(admin).not.toBe(alice);
    expect(admin.key).not.toBe(alice.key);
    expect(startTransport).toHaveBeenCalledTimes(2);
    manager.shutdown();
  });

  it("maps notifications to replayable sequenced events", async () => {
    const child = mockTransport();
    const manager = new CodexRuntimeManager({
      mode: "app-server",
      startTransport: async () => child,
    });
    const runtime = await manager.acquire(identity());
    const received: unknown[] = [];
    runtime.subscribe((message) => received.push(message));

    child.stdout.write(
      `${JSON.stringify({
        method: "item/completed",
        params: { threadId: "thread-1", turnId: "turn-1", item: { id: "item-1" } },
      })}\n`,
    );

    expect(runtime.replay(0)).toMatchObject([
      {
        sequence: 1,
        connectionProfileId: "server-91",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        method: "item/completed",
      },
    ]);
    expect(received).toHaveLength(1);
    manager.shutdown();
  });

  it("forwards server requests and writes their response", async () => {
    const child = mockTransport();
    const manager = new CodexRuntimeManager({
      mode: "app-server",
      startTransport: async () => child,
    });
    const runtime = await manager.acquire(identity());
    const received: any[] = [];
    const writes: string[] = [];
    runtime.subscribe((message) => received.push(message));
    child.stdin.on("data", (chunk) => writes.push(chunk.toString("utf8")));

    child.stdout.write(
      `${JSON.stringify({ id: 41, method: "item/commandExecution/requestApproval", params: {} })}\n`,
    );
    expect(runtime.pendingServerRequests()).toHaveLength(1);
    runtime.respond(41, { decision: "accept" });

    expect(received[0]).toMatchObject({
      type: "server_request",
      request: { id: 41, method: "item/commandExecution/requestApproval" },
    });
    expect(writes.join("")).toContain('"id":41');
    expect(writes.join("")).toContain('"decision":"accept"');
    expect(runtime.pendingServerRequests()).toHaveLength(0);
    manager.shutdown();
  });

  it("uses all isolation dimensions in the opaque key", () => {
    expect(codexRuntimeKey(identity("admin", "server-91"))).not.toBe(
      codexRuntimeKey(identity("admin", "server-93")),
    );
  });
});

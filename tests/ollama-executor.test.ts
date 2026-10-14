import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import { ruleSchema, unwrap, type Snapshot } from "../lib/model";

const config = { baseUrl: "http://ollama.example:11434", model: "example-model:latest" };
const snapshot: Snapshot = {
  url: "https://example.com/",
  context: { key: "fixture", label: "fixture", origin: "https://example.com", kind: "page" },
  candidates: [],
};
const rules = [{ selector: "div.ad", category: "ad", enabled: true }];
const result = { model: config.model, modelCount: 1 };
const source = ts.transpileModule(
  readFileSync(new URL("../lib/ollama-executor.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function fixture() {
  let exists = false;
  const calls = {
    create: 0,
    close: 0,
    messages: [] as Record<string, unknown>[],
    heartbeats: 0,
    cleared: 0,
    direct: 0,
  };
  const api = {
    runtime: {
      getManifest: () => ({ manifest_version: 3 }),
      getURL: (path: string) => "chrome-extension://synthetic" + path,
      getContexts: async () => (exists ? [{}] : []),
      getPlatformInfo: async () => ({}),
      sendMessage: async (message: Record<string, unknown>) => {
        calls.messages.push(message);
        return { ok: true, data: message.type === "evaluate" ? rules : result };
      },
    },
    offscreen: {
      createDocument: async (options: { reasons: string[] }) => {
        assert.deepEqual(Array.from(options.reasons), ["WORKERS"]);
        calls.create++;
        exists = true;
      },
      closeDocument: async () => {
        calls.close++;
        exists = false;
      },
    },
  };
  const exported: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  runInNewContext(source, {
    exports: exported,
    require: (name: string) => {
      if (name === "wxt/browser") return { browser: api };
      if (name === "zod") return { z };
      if (name === "./model") return { ruleSchema, unwrap };
      if (name === "./ollama")
        return {
          evaluateOllama: async () => {
            calls.direct++;
            return rules;
          },
          testOllamaConnection: async () => {
            calls.direct++;
            return result;
          },
        };
      throw new Error("Unexpected mock dependency");
    },
    setInterval: () => {
      calls.heartbeats++;
      return 1;
    },
    clearInterval: () => {
      calls.cleared++;
    },
  });
  return { api, calls, exported };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("Chromium Ollama tasks target only the offscreen page and close it after completion", async () => {
  const { exported, calls } = fixture();
  assert.deepEqual(await exported.executeOllama!(snapshot, config), rules);
  assert.deepEqual(await exported.checkOllama!(config), result);
  assert.equal(calls.create, 2);
  assert.equal(calls.close, 2);
  assert.equal(calls.heartbeats, calls.cleared);
  assert.equal(calls.direct, 0);
  for (const message of calls.messages) assert.equal(message.target, "ollama-offscreen");
});

test("Concurrent Ollama tasks share a document and never close it while another task is pending", async () => {
  const { api, exported, calls } = fixture();
  const responses = [
    deferred<{ ok: boolean; data: unknown }>(),
    deferred<{ ok: boolean; data: unknown }>(),
  ];
  api.runtime.sendMessage = async (message) => {
    calls.messages.push(message);
    return responses[calls.messages.length - 1]!.promise as Promise<{
      ok: boolean;
      data: typeof rules | typeof result;
    }>;
  };
  const first = exported.executeOllama!(snapshot, config);
  const second = exported.checkOllama!(config);
  await setImmediate();
  assert.equal(calls.create, 1);
  assert.equal(calls.messages.length, 2);
  responses[0]!.resolve({ ok: true, data: rules });
  await first;
  assert.equal(calls.close, 0);
  responses[1]!.resolve({ ok: true, data: result });
  await second;
  assert.equal(calls.close, 1);
});

test("Firefox MV2 uses its background page and Chromium without offscreen does not fall back", async () => {
  const { api, exported, calls } = fixture();
  api.runtime.getManifest = () => ({ manifest_version: 2 });
  assert.deepEqual(await exported.executeOllama!(snapshot, config), rules);
  assert.deepEqual(await exported.checkOllama!(config), result);
  assert.equal(calls.direct, 2);
  assert.equal(calls.create, 0);
  api.runtime.getManifest = () => ({ manifest_version: 3 });
  Object.assign(api, { offscreen: undefined });
  await assert.rejects(exported.executeOllama!(snapshot, config), /Chromium 116 or newer/);
});

test("Ollama transport failures discard private browser diagnostics and still close the worker", async () => {
  const { api, exported, calls } = fixture();
  api.runtime.sendMessage = async () => {
    throw new Error("Private URL or infrastructure diagnostics");
  };
  await assert.rejects(exported.executeOllama!(snapshot, config), {
    message: "Ollama background connection interrupted. Existing rules were kept; retry manually.",
  });
  assert.equal(calls.close, 1);
  assert.equal(calls.heartbeats, calls.cleared);
});

test("Ollama rejects malformed offscreen replies before applying rules", async () => {
  const { api, exported } = fixture();
  api.runtime.sendMessage = async () => ({ unexpected: "malformed" }) as never;
  await assert.rejects(exported.executeOllama!(snapshot, config), /Invalid Ollama worker reply/);
  api.runtime.sendMessage = async () =>
    ({ ok: true, data: [{ selector: "body", category: "unsupported", enabled: true }] }) as never;
  await assert.rejects(exported.executeOllama!(snapshot, config));
});

test("A new Ollama request waits for document shutdown and then creates its own worker", async () => {
  const { api, exported, calls } = fixture();
  const closed = deferred<void>();
  const originalClose = api.offscreen.closeDocument;
  let closing = false;
  api.offscreen.closeDocument = async () => {
    closing = true;
    await closed.promise;
    await originalClose();
  };
  const first = exported.executeOllama!(snapshot, config);
  await setImmediate();
  assert.equal(closing, true);
  const second = exported.checkOllama!(config);
  closed.resolve();
  await Promise.all([first, second]);
  assert.equal(calls.create, 2);
  assert.equal(calls.close, 2);
  assert.equal(calls.messages.length, 2);
});

test("Offscreen rejects page and popup senders before starting a worker", async () => {
  type Sender = { id: string; url?: string; tab?: object };
  let listener!: (raw: unknown, sender: Sender, respond: (reply: unknown) => void) => unknown;
  let workers = 0;
  let terminated = 0;
  const pageSource = ts.transpileModule(
    readFileSync(
      new URL("../entrypoints/ollama-offscreen/main.ts", import.meta.url),
      "utf8",
    ).replaceAll("import.meta.url", '"https://extension.invalid/offscreen"'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  class MockWorker {
    onmessage?: (event: { data: unknown }) => void;
    constructor() {
      workers++;
    }
    postMessage() {
      queueMicrotask(() => this.onmessage?.({ data: { ok: true, data: result } }));
    }
    terminate() {
      terminated++;
    }
  }
  const api = {
    runtime: {
      id: "synthetic",
      getURL: (path: string) => "chrome-extension://synthetic" + path,
      onMessage: {
        addListener: (callback: typeof listener) => {
          listener = callback;
        },
      },
    },
  };
  runInNewContext(pageSource, {
    exports: {},
    URL,
    Worker: MockWorker,
    require: (name: string) =>
      name === "wxt/browser"
        ? { browser: api }
        : name === "zod"
          ? { z }
          : name === "../../lib/model"
            ? { snapshotSchema: z.object({}) }
            : {},
    setTimeout: () => 1,
    clearTimeout: () => undefined,
  });
  const command = { target: "ollama-offscreen", type: "check", config };
  let replies = 0;
  for (const sender of [
    { id: "external", url: "chrome-extension://synthetic/background.js" },
    { id: "synthetic", tab: {}, url: "https://example.com" },
    { id: "synthetic", url: "chrome-extension://synthetic/popup.html" },
    { id: "synthetic", url: "https://example.com" },
  ])
    listener(command, sender, () => {
      replies++;
    });
  assert.equal(workers, 0);
  assert.equal(replies, 0);
  let received: unknown;
  assert.equal(
    listener(
      command,
      { id: "synthetic", url: "chrome-extension://synthetic/background.js" },
      (reply) => {
        received = reply;
      },
    ),
    true,
  );
  await setImmediate();
  assert.equal(workers, 1);
  assert.equal(terminated, 1);
  assert.deepEqual(received, { ok: true, data: result });
});

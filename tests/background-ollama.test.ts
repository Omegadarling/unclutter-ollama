import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";
import {
  ANALYSIS_VERSION,
  POLICY_VERSION,
  contextSchema,
  hasProviderConnection,
  profileSchema,
  shouldAutoAnalyze,
  snapshotSchema,
  unwrap,
  type Reply,
  type Rule,
  type Snapshot,
} from "../lib/model";
import { validateOllamaConfig, type OllamaConfig } from "../lib/ollama";
import { providerKeyLabel, providers, resolveProvider } from "../lib/providers";

const source = await readFile(new URL("../entrypoints/background.ts", import.meta.url), "utf8");
const script = ts.transpileModule(
  source.replace(/^import[\s\S]*?from [^;]+;\s*/gm, "").replace("export default ", ""),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
).outputText;
const extensionId = "synthetic-extension";
const popupUrl = `chrome-extension://${extensionId}/popup.html`;
const snapshot: Snapshot = {
  url: "https://page.example/article",
  context: {
    origin: "https://page.example",
    key: `https://page.example|v${POLICY_VERSION}|article`,
    label: "Article",
    kind: "article",
  },
  candidates: [
    {
      id: "e0",
      selector: "div.ad-banner",
      tag: "div",
      signals: "advertisement",
      text: "Advertisement",
      position: "static",
      count: 1,
    },
  ],
};
type Sender = { id: string; url?: string; frameId?: number; tab?: { id?: number } };
type Listener = (raw: unknown, sender: Sender, respond: (reply: Reply<unknown>) => void) => boolean;
const trustedPopup: Sender = { id: extensionId, url: popupUrl };
const webpage: Sender = {
  id: extensionId,
  url: snapshot.url,
  frameId: 0,
  tab: { id: 1 },
};
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function background(
  initial: Record<string, unknown> = {},
  inference: () => Promise<Rule[]> = async () => [],
) {
  const storage: Record<string, unknown> = structuredClone(initial);
  const writes: Record<string, unknown>[] = [];
  const checks: OllamaConfig[] = [];
  const analyses: OllamaConfig[] = [];
  let listener: Listener | undefined;
  vm.runInNewContext(
    script,
    {
      z,
      ANALYSIS_VERSION,
      POLICY_VERSION,
      contextSchema,
      hasProviderConnection,
      profileSchema,
      shouldAutoAnalyze,
      snapshotSchema,
      unwrap,
      validateOllamaConfig,
      providerKeyLabel,
      providers,
      resolveProvider,
      URL,
      Error,
      setInterval: () => 1,
      clearInterval: () => undefined,
      defineBackground: (start: () => void) => start(),
      evaluate: async () => {
        throw new Error("Unexpected cloud inference.");
      },
      executeOllama: async (_snapshot: Snapshot, config: OllamaConfig) => {
        analyses.push(config);
        return inference();
      },
      checkOllama: async (config: OllamaConfig) => {
        checks.push(config);
        return { model: config.model, modelCount: 1 };
      },
      browser: {
        action: {
          setBadgeText: async () => undefined,
          setBadgeBackgroundColor: async () => undefined,
          setTitle: async () => undefined,
        },
        storage: {
          local: {
            get: async (keys: string | string[]) =>
              Object.fromEntries(
                (typeof keys === "string" ? [keys] : keys)
                  .filter((key) => key in storage)
                  .map((key) => [key, structuredClone(storage[key])]),
              ),
            set: async (values: Record<string, unknown>) => {
              writes.push(structuredClone(values));
              Object.assign(storage, structuredClone(values));
            },
            remove: async (keys: string | string[]) => {
              for (const key of typeof keys === "string" ? [keys] : keys) delete storage[key];
            },
            setAccessLevel: async () => undefined,
          },
        },
        tabs: {
          query: async () => [],
          sendMessage: async (_tabId: number, message: { type: string }) => ({
            ok: true,
            data:
              message.type === "snapshot"
                ? structuredClone(snapshot)
                : {
                    context: snapshot.context,
                    profile: null,
                    enabled: true,
                    hiddenCount: 0,
                  },
          }),
          onRemoved: { addListener: () => undefined },
          onUpdated: { addListener: () => undefined },
        },
        runtime: {
          id: extensionId,
          getURL: (path: string) => `chrome-extension://${extensionId}${path}`,
          getPlatformInfo: async () => ({}),
          onMessage: {
            addListener: (callback: Listener) => {
              listener = callback;
            },
          },
        },
      },
    },
    { filename: "background.test.js" },
  );
  assert.ok(listener, "Background registers its runtime listener");
  const dispatch = listener;
  return {
    storage,
    writes,
    checks,
    analyses,
    dispatch,
    request: (message: unknown, sender = trustedPopup) =>
      new Promise<Reply<unknown>>((resolve) => {
        assert.equal(dispatch(message, sender, resolve), true);
      }),
  };
}

test("new installs expose empty Ollama settings to trusted popup windows and extension tabs", async () => {
  const app = background();
  for (const sender of [trustedPopup, { ...trustedPopup, tab: { id: 2 }, frameId: 0 }]) {
    const reply = await app.request({ type: "settings" }, sender);
    assert.equal(reply.ok, true);
    if (reply.ok)
      assert.deepEqual(JSON.parse(JSON.stringify(reply.data)), {
        enabled: true,
        hasKey: false,
        hasOllama: false,
        ollamaUrl: "",
        ollamaModel: "",
        provider: "ollama",
        mode: "manual",
      });
  }
  assert.deepEqual(app.storage, {});
});

test("saving validates and normalizes the connection without making inference or test calls", async () => {
  const app = background({ provider: "vercel" });
  assert.equal(
    (
      await app.request({
        type: "saveOllama",
        url: " ollama.example ",
        model: " fixture-model:latest ",
      })
    ).ok,
    true,
  );
  assert.deepEqual(app.storage, {
    provider: "ollama",
    ollamaUrl: "http://ollama.example:11434",
    ollamaModel: "fixture-model:latest",
  });
  assert.equal(app.checks.length, 0);
  assert.equal(app.analyses.length, 0);
  assert.equal(app.writes.length, 1);
});

test("invalid addresses or models leave stored connections untouched", async () => {
  const initial = {
    provider: "ollama",
    ollamaUrl: "http://ollama.example:11434",
    ollamaModel: "fixture-model:latest",
  };
  const app = background(initial);
  for (const connection of [
    { url: "ftp://ollama.example", model: "fixture-model:latest" },
    { url: "http://user:password@ollama.example", model: "fixture-model:latest" },
    { url: "http://ollama.example?secret=fixture", model: "fixture-model:latest" },
    { url: "http://ollama.example", model: "" },
    { url: "http://ollama.example", model: "invalid model" },
  ]) {
    const reply = await app.request({ type: "saveOllama", ...connection });
    assert.equal(reply.ok, false);
  }
  assert.deepEqual(app.storage, initial);
  assert.equal(app.writes.length, 0);
  assert.equal(app.checks.length, 0);
  assert.equal(app.analyses.length, 0);
});

test("testing uses unsaved normalized input and keeps existing saved settings", async () => {
  const initial = {
    provider: "ollama",
    ollamaUrl: "http://ollama.example:11434",
    ollamaModel: "saved-model:latest",
  };
  const app = background(initial);
  const reply = await app.request({
    type: "testOllama",
    url: "other-ollama.example:11435",
    model: "fixture-model:latest",
  });
  assert.equal(reply.ok, true);
  assert.deepEqual(app.checks, [
    { baseUrl: "http://other-ollama.example:11435", model: "fixture-model:latest" },
  ]);
  assert.deepEqual(app.storage, initial);
  assert.equal(app.writes.length, 0);
});

test("webpage messages cannot read settings or set or test Ollama connections", async () => {
  const app = background({
    provider: "ollama",
    ollamaUrl: "http://ollama.example:11434",
    ollamaModel: "fixture-model:latest",
  });
  for (const message of [
    { type: "settings" },
    { type: "saveOllama", url: "other-ollama.example", model: "other-model:latest" },
    { type: "testOllama", url: "other-ollama.example", model: "other-model:latest" },
  ]) {
    const reply = await app.request(message, webpage);
    assert.equal(reply.ok, false);
    assert.doesNotMatch(JSON.stringify(reply), /ollama\.example|fixture-model/);
  }
  const foreignPopup = await app.request({ type: "settings" }, { ...trustedPopup, id: "foreign" });
  assert.equal(foreignPopup.ok, false);
  const offscreen = await app.request(
    { type: "settings" },
    { id: extensionId, url: `chrome-extension://${extensionId}/ollama-offscreen.html` },
  );
  assert.equal(offscreen.ok, false);
  assert.equal(app.writes.length, 0);
  assert.equal(app.checks.length, 0);
});

test("the private offscreen channel returns no background response", async () => {
  const app = background();
  const responses: Reply<unknown>[] = [];
  assert.equal(
    app.dispatch({ target: "ollama-offscreen", type: "settings" }, trustedPopup, (reply) =>
      responses.push(reply),
    ),
    false,
  );
  await flush();
  assert.deepEqual(responses, []);
  assert.equal(app.writes.length, 0);
});

test("valid page sync enables automatic Ollama use without a cloud API key and hides connection values", async () => {
  const app = background({
    provider: "ollama",
    mode: "auto",
    ollamaUrl: "http://ollama.example:11434",
    ollamaModel: "fixture-model:latest",
  });
  const message = { type: "sync", context: snapshot.context, hiddenCount: 0 };
  const reply = await app.request(message, webpage);
  assert.equal(reply.ok, true);
  if (reply.ok)
    assert.deepEqual(JSON.parse(JSON.stringify(reply.data)), {
      profile: null,
      enabled: true,
      autoEnabled: true,
    });
  assert.doesNotMatch(JSON.stringify(reply), /ollama\.example|fixture-model|apiKey/);
  for (const sender of [
    { ...webpage, frameId: 1 },
    { ...webpage, url: "https://other-page.example/article" },
  ])
    assert.equal((await app.request(message, sender)).ok, false);
  assert.equal(
    (
      await app.request(
        { ...message, context: { ...snapshot.context, key: "foreign-key" } },
        webpage,
      )
    ).ok,
    false,
  );
});

test("changing the saved connection while analysis runs discards its result", async () => {
  let finish!: (rules: Rule[]) => void;
  const pending = new Promise<Rule[]>((resolve) => {
    finish = resolve;
  });
  const app = background(
    {
      provider: "ollama",
      ollamaUrl: "http://ollama.example:11434",
      ollamaModel: "fixture-model:latest",
    },
    () => pending,
  );
  const analysis = app.request({ type: "analyze", tabId: 1 });
  await flush();
  assert.equal(app.analyses.length, 1);
  assert.equal(
    (
      await app.request({
        type: "saveOllama",
        url: "other-ollama.example",
        model: "other-model:latest",
      })
    ).ok,
    true,
  );
  finish([{ selector: "div.ad-banner", category: "ad", enabled: true }]);
  const reply = await analysis;
  assert.equal(reply.ok, false);
  if (!reply.ok) assert.match(reply.error, /Connection changed during analysis.*Result discarded/);
  assert.equal(
    Object.keys(app.storage).some((key) => key.startsWith("profile:")),
    false,
  );
  assert.equal(app.storage.ollamaModel, "other-model:latest");
});

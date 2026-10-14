import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import ts from "typescript";
import { ANALYSIS_VERSION, unwrap } from "../lib/model";
import { providerKeyLabel, providerLabel, resolveProvider, type Provider } from "../lib/providers";

const [html, popupSource] = await Promise.all([
  readFile(new URL("../entrypoints/popup/index.html", import.meta.url), "utf8"),
  readFile(new URL("../entrypoints/popup/main.ts", import.meta.url), "utf8"),
]);
// Run the real popup controller in a DOM with a synthetic extension API.
const popupScript = ts.transpileModule(
  popupSource
    .replace(/^import[\s\S]*?from [^;]+;\s*/gm, "")
    .replace(/^import "\.\/style\.css";\s*/m, ""),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
).outputText;
type Config = {
  enabled: boolean;
  hasKey: boolean;
  hasOllama: boolean;
  ollamaUrl: string;
  ollamaModel: string;
  mode: "manual" | "auto";
  provider: Provider;
};
type TestReply =
  | { ok: true; data: { model: string; modelCount: number } }
  | { ok: false; error: string };
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

async function popup(
  overrides: Partial<Config> = {},
  testReply: Promise<TestReply> | TestReply = {
    ok: true,
    data: { model: "test-model:latest", modelCount: 1 },
  },
) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://extension.invalid" });
  const config: Config = {
    enabled: true,
    hasKey: false,
    hasOllama: false,
    ollamaUrl: "",
    ollamaModel: "",
    mode: "manual",
    provider: "ollama",
    ...overrides,
  };
  const messages: Record<string, unknown>[] = [];
  const timers = new Map<number, () => void>();
  let timerId = 0;
  Object.assign(dom.window, {
    ANALYSIS_VERSION,
    unwrap,
    providerKeyLabel,
    providerLabel,
    resolveProvider,
    Error,
    setTimeout: (callback: () => void) => {
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
    browser: {
      tabs: { query: async () => [{ id: 1 }] },
      runtime: {
        sendMessage: async (message: Record<string, unknown>) => {
          messages.push({ ...message });
          switch (message.type) {
            case "settings":
              return { ok: true, data: { ...config } };
            case "status":
              return {
                ok: true,
                data: {
                  context: { origin: "https://example.invalid", key: "test", label: "Test page" },
                  profile: null,
                  hiddenCount: 0,
                  busy: false,
                  error: null,
                },
              };
            case "testOllama":
              return await testReply;
            case "saveOllama":
              config.hasOllama = true;
              config.ollamaUrl = "http://ollama.invalid:11434";
              config.ollamaModel = String(message.model);
              break;
            case "provider":
              config.provider = resolveProvider(message.provider);
              break;
            case "mode":
              config.mode = message.mode as Config["mode"];
              break;
            case "saveKey":
              config.hasKey = true;
              break;
          }
          return { ok: true, data: null };
        },
      },
    },
  });
  dom.window.eval(popupScript);
  await flush();
  const element = <T extends HTMLElement>(id: string) => {
    const found = dom.window.document.getElementById(id);
    assert.ok(found, `Popup element ${id} exists`);
    return found as T;
  };
  const input = (id: string, value: string) => {
    element<HTMLInputElement>(id).value = value;
    element(id).dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const submit = (id: string) =>
    element(id).dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  return {
    config,
    messages,
    element,
    input,
    submit,
    close: () => dom.window.close(),
    select: (id: string, value: string) => {
      element<HTMLSelectElement>(id).value = value;
      element(id).dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    },
    poll: async () => {
      const timer = timers.entries().next().value;
      assert.ok(timer, "Popup has a scheduled status poll");
      timers.delete(timer[0]);
      timer[1]();
      await flush();
    },
  };
}

test("Ollama requires saved settings; testing unsaved fields never saves them", async (t) => {
  const ui = await popup();
  t.after(ui.close);
  assert.equal(ui.element<HTMLInputElement>("ollama-url").value, "");
  assert.equal(ui.element<HTMLInputElement>("ollama-model").value, "");
  assert.equal(ui.element<HTMLButtonElement>("analyze").disabled, true);
  assert.equal(ui.element("key-form").hidden, true);
  assert.equal(ui.element("ollama-form").hidden, false);
  assert.doesNotMatch(ui.element("auto-disclosure").textContent ?? "", /API charges/);

  ui.input("ollama-url", " ollama.invalid ");
  ui.input("ollama-model", " test-model:latest ");
  ui.element<HTMLButtonElement>("test-ollama").click();
  await flush();
  assert.equal(ui.config.hasOllama, false);
  assert.equal(
    ui.messages.some((message) => message.type === "saveOllama"),
    false,
  );
  assert.deepEqual(
    ui.messages.find((message) => message.type === "testOllama"),
    {
      type: "testOllama",
      url: "ollama.invalid",
      model: "test-model:latest",
    },
  );
  assert.match(ui.element("ollama-test-status").textContent ?? "", /Connected.*Save connection/);
  assert.equal(ui.element<HTMLButtonElement>("analyze").disabled, true);

  ui.submit("ollama-form");
  await flush();
  assert.equal(ui.config.hasOllama, true);
  assert.equal(ui.element<HTMLInputElement>("ollama-url").value, "http://ollama.invalid:11434");
  assert.equal(ui.element<HTMLInputElement>("ollama-model").value, "test-model:latest");
  assert.equal(ui.element<HTMLButtonElement>("analyze").disabled, false);
  assert.match(ui.element("key-status").textContent ?? "", /Connection saved/);
});

test("status polling and provider changes preserve an edited server and model", async (t) => {
  const ui = await popup({
    hasOllama: true,
    ollamaUrl: "http://ollama.invalid:11434",
    ollamaModel: "saved-model:latest",
    mode: "auto",
  });
  t.after(ui.close);
  ui.input("ollama-url", "other-server.invalid");
  ui.input("ollama-model", "different-model:latest");
  await ui.poll();
  assert.equal(ui.element<HTMLInputElement>("ollama-url").value, "other-server.invalid");
  assert.equal(ui.element<HTMLInputElement>("ollama-model").value, "different-model:latest");
  assert.equal(ui.config.ollamaModel, "saved-model:latest");

  ui.select("provider", "vercel");
  await flush();
  assert.equal(ui.config.provider, "vercel");
  assert.equal(ui.element("key-form").hidden, false);
  assert.equal(ui.element("ollama-form").hidden, true);
  assert.equal(ui.element<HTMLButtonElement>("analyze").disabled, true);
  assert.match(ui.element("auto-disclosure").textContent ?? "", /API charges/);
  ui.select("provider", "ollama");
  await flush();
  assert.equal(ui.element<HTMLInputElement>("ollama-url").value, "other-server.invalid");
  assert.equal(ui.element<HTMLInputElement>("ollama-model").value, "different-model:latest");
});

test("failed connection tests show an error and release the connection controls", async (t) => {
  const ui = await popup({}, { ok: false, error: "Ollama server is unreachable." });
  t.after(ui.close);
  ui.input("ollama-url", "ollama.invalid");
  ui.input("ollama-model", "test-model:latest");
  ui.element<HTMLButtonElement>("test-ollama").click();
  await flush();
  assert.equal(ui.element("error").hidden, false);
  assert.equal(ui.element("error").textContent, "Ollama server is unreachable.");
  assert.equal(ui.element("ollama-test-status").hidden, true);
  assert.equal(ui.element<HTMLButtonElement>("test-ollama").disabled, false);
  assert.equal(ui.element<HTMLButtonElement>("save-ollama").disabled, false);
  assert.equal(ui.config.hasOllama, false);
});

test("editing fields during a connection test discards the old result", async (t) => {
  let complete!: (reply: TestReply) => void;
  const reply = new Promise<TestReply>((resolve) => {
    complete = resolve;
  });
  const ui = await popup({}, reply);
  t.after(ui.close);
  ui.input("ollama-url", "ollama.invalid");
  ui.input("ollama-model", "test-model:latest");
  ui.element<HTMLButtonElement>("test-ollama").click();
  assert.equal(ui.element<HTMLButtonElement>("test-ollama").disabled, true);
  ui.input("ollama-model", "another-model:latest");
  complete({ ok: true, data: { model: "test-model:latest", modelCount: 1 } });
  await flush();
  assert.equal(ui.element("ollama-test-status").hidden, true);
  assert.equal(ui.element<HTMLInputElement>("ollama-model").value, "another-model:latest");
  assert.equal(ui.element<HTMLButtonElement>("test-ollama").disabled, false);
});

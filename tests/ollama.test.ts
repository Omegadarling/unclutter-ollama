import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateOllama,
  normalizeOllamaUrl,
  testOllamaConnection,
  validateOllamaConfig,
} from "../lib/ollama";
import type { Snapshot } from "../lib/model";

const config = { baseUrl: "http://ollama.example:11434", model: "example-model:latest" };
const snapshot: Snapshot = {
  url: "https://example.com/article?token=private",
  context: { key: "synthetic", kind: "article", label: "article", origin: "https://example.com" },
  candidates: [
    {
      id: "e0",
      selector: "div.local-ad-selector",
      tag: "div",
      signals: "advertisement",
      text: "Advertisement",
      position: "static",
      count: 1,
    },
    {
      id: "e1",
      selector: "div.local-cookie-selector",
      tag: "div",
      signals: "cookie consent",
      text: "Privacy settings",
      position: "fixed",
      count: 1,
    },
  ],
};
const result = () => ({
  answers: {
    e0: { choice: "ad", confidence: 0.95 },
    e1: { choice: "cookie", confidence: 0.99 },
  },
});
function chatResponse(value: unknown, split = false): Response {
  const content = JSON.stringify(value);
  if (!split) return Response.json({ message: { content }, done: true });
  const midpoint = Math.floor(content.length / 2);
  const lines = [
    { message: { thinking: "intermediate reasoning" }, done: false },
    { message: { content: content.slice(0, midpoint) }, done: false },
    { message: { content: content.slice(midpoint) }, done: true },
  ]
    .map((chunk) => JSON.stringify(chunk))
    .join("\r\n");
  const bytes = new TextEncoder().encode(lines);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        // Transport boundaries can occur inside JSON, CRLF, or a text token.
        for (let offset = 0; offset < bytes.length; offset += 7)
          controller.enqueue(bytes.slice(offset, offset + 7));
        controller.close();
      },
    }),
  );
}

test("Ollama URLs accept user input and apply the default port only when absent", () => {
  assert.equal(normalizeOllamaUrl(" 192.0.2.10 "), "http://192.0.2.10:11434");
  assert.equal(normalizeOllamaUrl("ollama.example"), "http://ollama.example:11434");
  assert.equal(
    normalizeOllamaUrl("ollama.example:12345/proxy/"),
    "http://ollama.example:12345/proxy",
  );
  assert.equal(
    normalizeOllamaUrl("https://ollama.example/proxy"),
    "https://ollama.example:11434/proxy",
  );
  assert.equal(normalizeOllamaUrl("http://ollama.example:80/"), "http://ollama.example:80");
  assert.equal(normalizeOllamaUrl("https://ollama.example:443/"), "https://ollama.example:443");
  assert.equal(normalizeOllamaUrl("::1"), "http://[::1]:11434");
  assert.equal(normalizeOllamaUrl("[2001:db8::1]:12345"), "http://[2001:db8::1]:12345");
  for (const address of [
    "http://ollama.example:80",
    "https://ollama.example:443",
    "ollama.example",
    "ollama.example:12345/proxy/",
    "::1",
  ]) {
    const normalized = normalizeOllamaUrl(address);
    assert.equal(normalizeOllamaUrl(normalized), normalized);
  }
  assert.deepEqual(validateOllamaConfig("ollama.example", " example-model "), {
    baseUrl: config.baseUrl,
    model: "example-model",
  });
});

test("Ollama configuration rejects credentials, unsafe URL components, and invalid model names", () => {
  for (const url of [
    "",
    "ftp://ollama.example",
    "file:///private",
    "http://user:secret@ollama.example",
    "ollama.example?token=secret",
    "ollama.example#fragment",
    "ollama.example?",
    "ollama.example#",
    "bad host",
    "a".repeat(2049),
  ])
    assert.throws(() => normalizeOllamaUrl(url));
  for (const model of ["", " ", "model with spaces", "model\nprivate", "a".repeat(201)])
    assert.throws(() => validateOllamaConfig(config.baseUrl, model));
});

test("Ollama streams structured classifications and keeps private page metadata out of its request", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    assert.equal(url, config.baseUrl + "/api/chat");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(init.headers, { "Content-Type": "application/json" });
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, config.model);
    assert.equal(body.stream, true);
    assert.deepEqual(body.options, { temperature: 0 });
    assert.deepEqual(body.format.properties.answers.required, ["e0", "e1"]);
    assert.equal(body.format.properties.answers.additionalProperties, false);
    assert.deepEqual(body.format.properties.answers.properties.e0.required, [
      "choice",
      "confidence",
    ]);
    assert.equal(body.messages[0].role, "system");
    assert.match(body.messages[0].content, /untrusted evidence/);
    const state = JSON.parse(body.messages[1].content);
    assert.equal(state.elements.length, 2);
    assert.equal(state.pageType, "article");
    assert.ok(!String(init.body).includes("token=private"));
    assert.ok(!String(init.body).includes("https://example.com"));
    assert.ok(!String(init.body).includes("local-ad-selector"));
    return chatResponse(result(), true);
  });
  assert.deepEqual(await evaluateOllama(snapshot, config), [
    { selector: "div.local-ad-selector", category: "ad", enabled: true },
    { selector: "div.local-cookie-selector", category: "cookie", enabled: true },
  ]);
  assert.equal(fetch.mock.calls.length, 1);
});

test("Ollama keeps ambiguous content and enforces the confidence threshold", async (t) => {
  const output = result();
  t.mock.method(globalThis, "fetch", async () => chatResponse(output));
  output.answers.e0.confidence = 0.9;
  output.answers.e1.confidence = 0.89;
  assert.deepEqual(await evaluateOllama(snapshot, config), [
    { selector: "div.local-ad-selector", category: "ad", enabled: true },
  ]);
  const alternatives = output as {
    answers: Record<string, { choice: string; confidence: number }>;
  };
  alternatives.answers.e0!.choice = "keep";
  alternatives.answers.e1!.choice = "uncertain";
  alternatives.answers.e1!.confidence = 1;
  assert.deepEqual(await evaluateOllama(snapshot, config), []);
});

test("Ollama rejects incomplete, extra, and malformed classifications rather than returning partial rules", async (t) => {
  let output: unknown = {};
  t.mock.method(globalThis, "fetch", async () => chatResponse(output));
  const invalid = [
    { answers: { e0: { choice: "ad", confidence: 0.95 } } },
    { answers: { ...result().answers, e2: { choice: "ad", confidence: 0.95 } } },
    { answers: { ...result().answers, e0: { choice: "ad" } } },
    { answers: { ...result().answers, e0: { choice: "ad", confidence: "1" } } },
    { answers: { ...result().answers, e0: { choice: "ad", confidence: 1.1 } } },
    { answers: { ...result().answers, e0: { choice: "ad", confidence: -0.1 } } },
    { answers: { ...result().answers, e0: { choice: "arbitrary", confidence: 1 } } },
    { answers: { ...result().answers, e0: { choice: "ad", confidence: 1, selector: "body" } } },
  ];
  for (output of invalid)
    await assert.rejects(
      evaluateOllama(snapshot, config),
      /invalid classifications.*Existing rules were kept/,
    );
});

test("Ollama splits larger candidate sets into batches of at most eight and preserves local selectors", async (t) => {
  const large: Snapshot = {
    ...snapshot,
    candidates: Array.from({ length: 17 }, (_, index) => ({
      ...snapshot.candidates[0]!,
      id: "e" + index,
      selector: "div.synthetic-" + index,
    })),
  };
  const counts: number[] = [];
  const fetch = t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const state = JSON.parse(body.messages[1].content) as { elements: { id: string }[] };
    counts.push(state.elements.length);
    return chatResponse({
      answers: Object.fromEntries(
        state.elements.map(({ id }) => [id, { choice: "ad", confidence: 0.95 }]),
      ),
    });
  });
  const rules = await evaluateOllama(large, config);
  assert.equal(fetch.mock.calls.length, 3);
  assert.deepEqual(counts, [8, 8, 1]);
  assert.deepEqual(
    rules.map((rule) => rule.selector),
    large.candidates.map((candidate) => candidate.selector),
  );
});

test("Ollama does not return accumulated rules if a later batch fails", async (t) => {
  const large: Snapshot = {
    ...snapshot,
    candidates: Array.from({ length: 9 }, (_, index) => ({
      ...snapshot.candidates[0]!,
      id: "e" + index,
    })),
  };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    calls++;
    if (calls === 2) return new Response("private server body", { status: 500 });
    const body = JSON.parse(String(init.body));
    const state = JSON.parse(body.messages[1].content) as { elements: { id: string }[] };
    return chatResponse({
      answers: Object.fromEntries(
        state.elements.map(({ id }) => [id, { choice: "ad", confidence: 0.95 }]),
      ),
    });
  });
  await assert.rejects(evaluateOllama(large, config), /HTTP 500/);
  assert.equal(calls, 2);
});

test("Ollama errors do not disclose server response bodies or connection URLs", async (t) => {
  let response = new Response("private server details", { status: 403 });
  t.mock.method(globalThis, "fetch", async () => response);
  await assert.rejects(evaluateOllama(snapshot, config), {
    message:
      "Ollama request failed: HTTP 403. Check server or proxy access and the allowed extension origin.",
  });
  response = Response.json({ error: "private model and infrastructure details", done: true });
  await assert.rejects(evaluateOllama(snapshot, config), {
    message: "Ollama could not generate a response. Check the selected model and server.",
  });
  response = new Response("private non-JSON details");
  await assert.rejects(evaluateOllama(snapshot, config), {
    message: "Ollama returned invalid JSON. Existing rules were kept.",
  });
});

test("Ollama network failures and truncated streams are reported safely", async (t) => {
  let fail = true;
  t.mock.method(globalThis, "fetch", async () => {
    if (fail) throw new Error("Failed connection to a private server URL");
    return Response.json({ message: { content: JSON.stringify(result()) }, done: false });
  });
  await assert.rejects(evaluateOllama(snapshot, config), {
    message:
      "Could not connect to Ollama. Check the server address, LAN access, and allowed extension origin.",
  });
  fail = false;
  await assert.rejects(evaluateOllama(snapshot, config), /incomplete answer/);
});

test("Ollama bounds response sizes and skips network calls for empty snapshots", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("x".repeat(1_048_577)));
  assert.deepEqual(await evaluateOllama({ ...snapshot, candidates: [] }, config), []);
  assert.equal(fetch.mock.calls.length, 0);
  await assert.rejects(evaluateOllama(snapshot, config), /oversized response/);
});

test("Ollama connection checks verify the selected installed model and implicit latest tag", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    assert.equal(url, config.baseUrl + "/api/tags");
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    return Response.json({
      models: [{ name: "example-model:latest" }, { name: "other-model:small" }],
    });
  });
  assert.deepEqual(await testOllamaConnection({ ...config, model: "example-model" }), {
    model: "example-model:latest",
    modelCount: 2,
  });
  await assert.rejects(
    testOllamaConnection({ ...config, model: "missing-model" }),
    /selected model is not installed/,
  );
  assert.equal(fetch.mock.calls.length, 2);
});

test("Ollama connection checks preserve explicit tags and reject invalid model lists", async (t) => {
  let output: unknown = { models: [{ name: "example-model:small" }] };
  t.mock.method(globalThis, "fetch", async () => Response.json(output));
  await assert.rejects(testOllamaConnection(config), /selected model is not installed/);
  output = { unexpected: "private server metadata" };
  await assert.rejects(testOllamaConnection(config), {
    message: "The server did not return an Ollama model list.",
  });
});

test("Ollama shares a 240 second analysis deadline across batches", async (t) => {
  const large: Snapshot = {
    ...snapshot,
    candidates: Array.from({ length: 9 }, (_, index) => ({
      ...snapshot.candidates[0]!,
      id: "e" + index,
    })),
  };
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const durations: number[] = [];
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (duration: number) => {
    durations.push(duration);
    return originalTimeout(duration);
  });
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const state = JSON.parse(body.messages[1].content) as { elements: { id: string }[] };
    now = 131_000;
    return chatResponse({
      answers: Object.fromEntries(
        state.elements.map(({ id }) => [id, { choice: "ad", confidence: 0.95 }]),
      ),
    });
  });
  assert.equal((await evaluateOllama(large, config)).length, 9);
  assert.deepEqual(durations, [120_000, 110_000]);
});

test("Ollama discards all classifications when the overall analysis deadline is exceeded", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    now = 241_001;
    return chatResponse(result());
  });
  await assert.rejects(evaluateOllama(snapshot, config), /analysis timed out after 240 seconds/);
  assert.equal(fetch.mock.calls.length, 1);
});

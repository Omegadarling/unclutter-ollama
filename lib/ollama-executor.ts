import { browser } from "wxt/browser";
import { z } from "zod";
import { evaluateOllama, testOllamaConnection, type OllamaConfig } from "./ollama";
import { ruleSchema, unwrap, type Rule, type Snapshot } from "./model";

const OFFSCREEN_PATH = "/ollama-offscreen.html";
const connectionResult = z.object({
  model: z.string().min(1).max(512),
  modelCount: z.number().int().min(0).max(5000),
});
let pending = 0;
let lifecycle: Promise<void> = Promise.resolve();

// Creation and shutdown share a lock so a new task cannot race document teardown.
async function lock(operation: () => Promise<void>): Promise<void> {
  const task = lifecycle.then(operation);
  lifecycle = task.catch(() => undefined);
  await task;
}

async function ensureDocument(): Promise<void> {
  await lock(async () => {
    const contexts = await browser.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [browser.runtime.getURL(OFFSCREEN_PATH)],
    });
    if (contexts.length) return;
    await browser.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["WORKERS"],
      justification:
        "Run bounded Ollama network requests in a dedicated worker while a local model loads.",
    });
  });
}

async function dispatch(
  type: "evaluate" | "check",
  config: OllamaConfig,
  snapshot?: Snapshot,
): Promise<unknown> {
  if (!browser.offscreen?.createDocument || !browser.runtime.getContexts)
    throw new Error(
      "Ollama requires Chromium 116 or newer for background inference. Update your browser.",
    );
  pending++;
  const keepAlive = setInterval(() => {
    void browser.runtime.getPlatformInfo().catch(() => undefined);
  }, 20_000);
  try {
    try {
      await ensureDocument();
    } catch {
      throw new Error(
        "Could not start the Ollama background worker. Reload the extension and try again.",
      );
    }
    let reply: unknown;
    try {
      reply = await browser.runtime.sendMessage({
        target: "ollama-offscreen",
        type,
        config,
        ...(snapshot ? { snapshot } : {}),
      });
    } catch {
      throw new Error(
        "Ollama background connection interrupted. Existing rules were kept; retry manually.",
      );
    }
    const parsed = z
      .discriminatedUnion("ok", [
        z.object({ ok: z.literal(true), data: z.unknown() }),
        z.object({ ok: z.literal(false), error: z.string().max(1000) }),
      ])
      .safeParse(reply);
    if (!parsed.success) throw new Error("Invalid Ollama worker reply. Existing rules were kept.");
    return unwrap(parsed.data);
  } finally {
    clearInterval(keepAlive);
    pending--;
    if (!pending) {
      await lock(async () => {
        if (!pending) await browser.offscreen.closeDocument();
      }).catch(() => undefined);
    }
  }
}

export async function executeOllama(snapshot: Snapshot, config: OllamaConfig): Promise<Rule[]> {
  // Firefox's MV2 background page has no service-worker response deadline.
  if (browser.runtime.getManifest().manifest_version === 2) return evaluateOllama(snapshot, config);
  return z
    .array(ruleSchema)
    .max(60)
    .parse(await dispatch("evaluate", config, snapshot));
}

export async function checkOllama(
  config: OllamaConfig,
): Promise<{ model: string; modelCount: number }> {
  if (browser.runtime.getManifest().manifest_version === 2) return testOllamaConnection(config);
  return connectionResult.parse(await dispatch("check", config));
}

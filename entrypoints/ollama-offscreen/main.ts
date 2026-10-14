import { browser } from "wxt/browser";
import { z } from "zod";
import { snapshotSchema, type Reply } from "../../lib/model";

const configSchema = z.object({
  baseUrl: z.string().min(1).max(2048),
  model: z.string().min(1).max(200),
});
const commandSchema = z.discriminatedUnion("type", [
  z.object({
    target: z.literal("ollama-offscreen"),
    type: z.literal("evaluate"),
    config: configSchema,
    snapshot: snapshotSchema,
  }),
  z.object({
    target: z.literal("ollama-offscreen"),
    type: z.literal("check"),
    config: configSchema,
  }),
]);

browser.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (!raw || typeof raw !== "object" || !("target" in raw) || raw.target !== "ollama-offscreen")
    return;
  if (
    sender.id !== browser.runtime.id ||
    sender.tab ||
    (sender.url && sender.url !== browser.runtime.getURL("/background.js"))
  )
    return;
  const command = commandSchema.safeParse(raw);
  if (!command.success) {
    sendResponse({ ok: false, error: "Invalid Ollama worker request. Nothing changed." });
    return;
  }
  // A separate worker carries the actual fetch, so MV3 fetch-response deadlines do not apply.
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  let finished = false;
  let timeout: ReturnType<typeof setTimeout>;
  const finish = (reply: Reply<unknown>) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    worker.terminate();
    sendResponse(reply);
  };
  timeout = setTimeout(
    () =>
      finish({
        ok: false,
        error: "Ollama analysis timed out. Existing rules were kept; retry manually.",
      }),
    command.data.type === "evaluate" ? 245_000 : 125_000,
  );
  worker.onmessage = (event: MessageEvent<Reply<unknown>>) => finish(event.data);
  worker.onerror = () =>
    finish({ ok: false, error: "Ollama worker failed. Existing rules were kept; retry manually." });
  worker.onmessageerror = () =>
    finish({ ok: false, error: "Invalid Ollama worker result. Existing rules were kept." });
  worker.postMessage(command.data);
  return true;
});

import { z } from "zod";
import { evaluateOllama, testOllamaConnection, validateOllamaConfig } from "../../lib/ollama";
import { snapshotSchema } from "../../lib/model";

const configSchema = z.object({
  baseUrl: z.string().min(1).max(2048),
  model: z.string().min(1).max(200),
});
const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("evaluate"), config: configSchema, snapshot: snapshotSchema }),
  z.object({ type: z.literal("check"), config: configSchema }),
]);

self.onmessage = (event: MessageEvent<unknown>) => {
  const run = async (): Promise<unknown> => {
    const command = commandSchema.parse(event.data);
    const config = validateOllamaConfig(command.config.baseUrl, command.config.model);
    return command.type === "evaluate"
      ? evaluateOllama(command.snapshot, config)
      : testOllamaConnection(config);
  };
  void run().then(
    (data) => self.postMessage({ ok: true, data }),
    (error: unknown) =>
      self.postMessage({
        ok: false,
        error:
          error instanceof z.ZodError
            ? "Invalid Ollama worker data. Existing rules were kept."
            : error instanceof Error
              ? error.message
              : "Ollama worker failed. Existing rules were kept.",
      }),
  );
};

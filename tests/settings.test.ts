import assert from "node:assert/strict";
import test from "node:test";
import { hasProviderConnection, shouldAutoAnalyze, type Settings } from "../lib/model";

const local: Settings = {
  enabled: true,
  mode: "auto",
  provider: "ollama",
  apiKey: "",
  ollamaUrl: "http://ollama.example:11434",
  ollamaModel: "test-model:latest",
};
test("Ollama automatic analysis uses saved address and model without a cloud key", () => {
  assert.equal(hasProviderConnection(local), true);
  assert.equal(shouldAutoAnalyze(local, null, false), true);
  for (const settings of [
    { ...local, ollamaUrl: "" },
    { ...local, ollamaModel: " " },
    { ...local, ollamaUrl: undefined },
    { ...local, ollamaModel: undefined },
  ]) {
    assert.equal(hasProviderConnection(settings), false);
    assert.equal(shouldAutoAnalyze(settings, null, false), false);
  }
  assert.equal(shouldAutoAnalyze({ ...local, mode: "manual" }, null, false), false);
  assert.equal(shouldAutoAnalyze({ ...local, enabled: false }, null, false), false);
  assert.equal(shouldAutoAnalyze(local, null, true), false);
});
test("Cloud providers require their saved key even when Ollama is configured", () => {
  for (const provider of ["vercel", "typesafe"] as const) {
    assert.equal(hasProviderConnection({ ...local, provider }), false);
    assert.equal(shouldAutoAnalyze({ ...local, provider }, null, false), false);
    assert.equal(hasProviderConnection({ ...local, provider, apiKey: "synthetic-key" }), true);
  }
});

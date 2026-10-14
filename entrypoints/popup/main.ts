import { browser } from "wxt/browser";
import { ANALYSIS_VERSION, unwrap, type PageState, type Reply } from "../../lib/model";
import {
  providerLabel,
  providerKeyLabel,
  resolveProvider,
  type Provider,
} from "../../lib/providers";
import "./style.css";

const get = <T extends HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing popup element: ${id}`);
  return element as T;
};
const analyze = get<HTMLButtonElement>("analyze");
const toggle = get<HTMLButtonElement>("toggle");
const global = get<HTMLInputElement>("global");
const mode = get<HTMLSelectElement>("analysis-mode");
const provider = get<HTMLSelectElement>("provider");
const ollamaUrl = get<HTMLInputElement>("ollama-url");
const ollamaModel = get<HTMLInputElement>("ollama-model");
const errorBox = get("error");
let tabId: number | undefined;
let hasKey = false;
let hasOllama = false;
let working = false;
let testingOllama = false;
let savedProvider: Provider = "ollama";
let savedOllamaUrl = "";
let savedOllamaModel = "";
let ollamaFieldsDirty = false;
let ollamaRevision = 0;
let current: (PageState & { busy: boolean; error: string | null }) | null = null;
let poll: ReturnType<typeof setTimeout> | undefined;

async function request<T>(message: object): Promise<T> {
  return unwrap((await browser.runtime.sendMessage(message)) as Reply<T>);
}
function error(error: unknown) {
  errorBox.textContent =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unexpected error.";
  errorBox.hidden = false;
}
function render() {
  const busy = working || current?.busy;
  const selectedProvider = resolveProvider(provider.value);
  const isOllama = selectedProvider === "ollama";
  const ready = isOllama ? hasOllama : hasKey;
  analyze.disabled = !current || !ready || !global.checked || !!busy;
  analyze.textContent = busy ? "Analyzing…" : current?.profile ? "Re-analyze" : "Analyze page";
  toggle.hidden = !current?.profile;
  toggle.disabled = !!busy || !global.checked;
  toggle.textContent = current?.profile?.enabled ? "Pause" : "Resume";
  provider.disabled = working;
  get("key-form").hidden = isOllama;
  get("ollama-form").hidden = !isOllama;
  get<HTMLButtonElement>("save-ollama").disabled = working;
  get<HTMLButtonElement>("test-ollama").disabled = working;
  get<HTMLButtonElement>("test-ollama").textContent = testingOllama
    ? "Connecting…"
    : "Test connection";
  get<HTMLInputElement>("api-key").placeholder = `Paste ${providerKeyLabel(selectedProvider)} key`;
  get("key-status").textContent = isOllama
    ? hasOllama
      ? "Ollama · Connection saved"
      : "Server and model required"
    : hasKey
      ? `${selectedProvider === "typesafe" ? "TypeSafe" : "Vercel"} · Key saved`
      : "API key required";
  const destination = isOllama ? "your configured Ollama server" : providerLabel(selectedProvider);
  get("disclosure").textContent =
    `Analyze sends up to 60 element descriptions to ${destination}. Main article text and form values are excluded; snippets may still contain personal data.`;
  get("auto-disclosure").textContent =
    `On page visit automatically sends element snippets to ${destination} for new templates. Snippets may contain personal data.${isOllama ? "" : " API charges apply."} Cached templates are reused.`;
  get("provider-hint").textContent = isOllama
    ? "Ollama"
    : selectedProvider === "typesafe"
      ? "Jev"
      : "Vercel";
  get("remove-key").hidden = !hasKey;
  get("disclosure").hidden = !current || mode.value === "auto";
  get("auto-disclosure").hidden = mode.value !== "auto";
  get("mode-hint").textContent =
    mode.value === "auto"
      ? "On page visit · Cached templates reused"
      : "Manual analysis · Cached rules apply automatically";
  if (!current) return;
  const { profile, context, hiddenCount } = current;
  get("host").textContent = new URL(context.origin).hostname;
  get("template").textContent = context.label;
  get("hidden").textContent = String(hiddenCount);
  get("saved").textContent = profile
    ? `Saved ${new Date(profile.analyzedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
    : "";
  const status = get("status");
  const paused = !global.checked || profile?.enabled === false;
  status.textContent = busy
    ? "Analyzing"
    : paused
      ? "Paused"
      : profile
        ? profile.analysisVersion < ANALYSIS_VERSION
          ? "Update available"
          : "Saved template"
        : "Not analyzed";
  status.className = `badge ${busy ? "busy" : profile && !paused ? "active" : ""}`;
  get("rules-section").hidden = !profile;
  get("rule-count").textContent =
    `${profile?.rules.filter((rule) => rule.enabled).length ?? 0} rules`;
  const rules = get("rules");
  rules.replaceChildren();
  if (profile && !profile.rules.length) {
    const empty = document.createElement("p");
    empty.className = "disclosure";
    empty.textContent = profile.candidateCount
      ? "No clearly removable elements found."
      : "No safely targetable elements found.";
    rules.append(empty);
  }
  for (const rule of profile?.rules ?? []) {
    const label = document.createElement("label");
    label.className = "rule";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = rule.enabled;
    checkbox.disabled = !!busy;
    checkbox.setAttribute("aria-label", `Hide ${rule.selector}`);
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = rule.category;
    const selector = document.createElement("code");
    selector.textContent = rule.selector;
    info.append(title, selector);
    label.append(checkbox, info);
    rules.append(label);
    checkbox.addEventListener(
      "change",
      () => void act({ type: "rule", tabId, selector: rule.selector, enabled: checkbox.checked }),
    );
  }
}
async function load() {
  const config = await request<{
    enabled: boolean;
    hasKey: boolean;
    hasOllama: boolean;
    ollamaUrl: string;
    ollamaModel: string;
    mode: "manual" | "auto";
    provider: Provider;
  }>({
    type: "settings",
  });
  hasKey = config.hasKey;
  hasOllama = config.hasOllama;
  savedOllamaUrl = config.ollamaUrl;
  savedOllamaModel = config.ollamaModel;
  if (!ollamaFieldsDirty) {
    ollamaUrl.value = savedOllamaUrl;
    ollamaModel.value = savedOllamaModel;
  }
  global.checked = config.enabled;
  mode.value = config.mode;
  savedProvider = resolveProvider(config.provider);
  provider.value = savedProvider;
  if (tabId !== undefined) {
    try {
      current = await request({ type: "status", tabId });
      if (current?.error) error(current.error);
    } catch (err) {
      current = null;
      get("status").textContent = "Unavailable";
      error(err);
    }
  }
  render();
  clearTimeout(poll);
  if (
    current?.busy ||
    (current &&
      !current.error &&
      config.mode === "auto" &&
      config.enabled &&
      (savedProvider === "ollama" ? hasOllama : hasKey) &&
      current.profile?.enabled !== false &&
      (!current.profile || current.profile.analysisVersion < ANALYSIS_VERSION))
  )
    poll = setTimeout(() => void load().catch(error), 900);
}
async function act(message: object, savedOllamaRevision?: number): Promise<boolean> {
  if (working) return false;
  working = true;
  errorBox.hidden = true;
  get("notice").hidden = true;
  render();
  try {
    await request(message);
    if (savedOllamaRevision === ollamaRevision) ollamaFieldsDirty = false;
    await load();
    return true;
  } catch (err) {
    provider.value = savedProvider;
    error(err);
    return false;
  } finally {
    working = false;
    render();
  }
}

analyze.addEventListener("click", () => void act({ type: "analyze", tabId }));
toggle.addEventListener(
  "click",
  () => void act({ type: "toggle", tabId, enabled: !current?.profile?.enabled }),
);
global.addEventListener("change", () => void act({ type: "global", enabled: global.checked }));
mode.addEventListener("change", () => void act({ type: "mode", mode: mode.value }));
provider.addEventListener(
  "change",
  () => void act({ type: "provider", provider: resolveProvider(provider.value) }),
);
get("forget").addEventListener("click", () => void act({ type: "forget", tabId }));
get("remove-key").addEventListener("click", () => void act({ type: "removeKey" }));
get("key-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = get<HTMLInputElement>("api-key");
  const key = input.value.trim();
  if (!key) {
    error(new Error(`Enter a ${providerKeyLabel(resolveProvider(provider.value))} API key.`));
    return;
  }
  void (async () => {
    await act({ type: "saveKey", key, provider: resolveProvider(provider.value) });
    input.value = "";
    if (errorBox.hidden) {
      get<HTMLDetailsElement>("connection").open = false;
      get("notice").textContent = "API key saved. Analyze a page to verify access.";
      get("notice").hidden = false;
    }
  })();
});
function readOllamaConnection(): { url: string; model: string } | null {
  const url = ollamaUrl.value.trim();
  const model = ollamaModel.value.trim();
  if (!url || !model) {
    error(new Error("Enter your Ollama server address and model name."));
    return null;
  }
  return { url, model };
}
for (const input of [ollamaUrl, ollamaModel]) {
  input.addEventListener("input", () => {
    ollamaFieldsDirty = true;
    ollamaRevision++;
    get("ollama-test-status").hidden = true;
  });
}
get("ollama-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const connection = readOllamaConnection();
  if (!connection) return;
  const revision = ollamaRevision;
  void (async () => {
    const saved = await act({ type: "saveOllama", ...connection }, revision);
    if (saved) {
      get("ollama-test-status").hidden = true;
      get("notice").textContent = "Ollama connection saved.";
      get("notice").hidden = false;
    }
  })();
});
get("test-ollama").addEventListener("click", () => {
  if (working) return;
  const connection = readOllamaConnection();
  if (!connection) return;
  const revision = ollamaRevision;
  const status = get("ollama-test-status");
  void (async () => {
    working = true;
    testingOllama = true;
    errorBox.hidden = true;
    get("notice").hidden = true;
    status.hidden = true;
    render();
    try {
      const result = await request<{ model: string; modelCount: number }>({
        type: "testOllama",
        ...connection,
      });
      if (revision === ollamaRevision) {
        const isSaved =
          hasOllama && connection.url === savedOllamaUrl && connection.model === savedOllamaModel;
        status.textContent = `Connected · ${result.model} (${result.modelCount} ${result.modelCount === 1 ? "model" : "models"} available).${isSaved ? "" : " Save connection to use these settings."}`;
        status.hidden = false;
      }
    } catch (err) {
      if (revision === ollamaRevision) error(err);
    } finally {
      working = false;
      testingOllama = false;
      render();
    }
  })();
});
void (async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  await load();
  get<HTMLDetailsElement>("connection").open = !(savedProvider === "ollama" ? hasOllama : hasKey);
})().catch(error);

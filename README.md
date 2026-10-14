# Unclutter Ollama

A browser extension that hides page clutter using a model on a user-configured Ollama server. This is an MIT-licensed fork of [kitze/unclutter](https://github.com/kitze/unclutter), created by Kitze. The original Vercel AI Gateway and TypeSafe AI providers remain available.

## Install in Brave, Chrome, or Edge

Download and extract the Chromium ZIP from this fork's Releases page, or build from source below. Open `brave://extensions` (`chrome://extensions` in Chrome), enable **Developer mode**, choose **Load unpacked**, and select the extracted folder containing `manifest.json`. Keep that folder in place. Pin the extension and refresh already-open website tabs.

## Configure Ollama

1. Open the extension popup and expand **Connection**. Choose **Ollama**.
2. Enter your Ollama server's IP address, hostname, or HTTP(S) URL. If you omit the scheme, HTTP is used; if you omit the port, port 11434 is used. An explicit port is preserved.
3. Enter the exact model name shown by `ollama list` on the server, including its tag when applicable. The model must already be installed; the extension does not download models.
4. Use **Test connection** to check server access and whether that model is listed, then **Save connection**. Testing checks availability; it does not run an inference.
5. On a normal website, choose **Analyze page**. **Manual** is the default. **On page visit** optionally analyzes new page templates automatically.

The address and model start blank and are stored only in local browser extension storage. No server address, model selection, account, or credential is bundled into this fork or its releases. The extension calls your configured Ollama server directly from a dedicated background worker; no separate app backend is required. With a local model, the Ollama path makes no Gateway or TypeSafe requests. Ollama cloud-backed models may send requests upstream according to their own configuration.

### Make Ollama reachable from another computer

Ollama normally listens on loopback. To use a LAN server, configure `OLLAMA_HOST` on that server to listen on an appropriate interface, allow the Ollama port through its firewall for your client, and restart Ollama. Use the server's reachable address in the extension. Refer to [Ollama's networking and environment-variable instructions](https://docs.ollama.com/faq). No changes are made to your server by this extension.

If Ollama rejects the browser extension origin, add that specific origin to `OLLAMA_ORIGINS` on the server. The extension ID appears on its card in the browser's extensions page: Chromium origins use `chrome-extension://<extension-id>`. Avoid granting every website access to your server.

## Behavior and limits

- The extension extracts up to 60 bounded candidate descriptions. The model receives their IDs, short text, structural signals, and page kind; it receives no selectors, full page URL, form values, or main article body.
- Ollama requests use structured JSON and small batches. Every candidate must receive a valid category and confidence. Invalid, incomplete, truncated, or failed responses leave existing saved rules unchanged.
- Only removable categories with model-reported confidence at least 0.9 become rules. Model confidence is not a calibrated probability; results depend on the chosen model. Ambiguous elements stay visible.
- Selectors are created and checked by the extension. Model output cannot supply executable code or selectors. Useful content, ordinary forms, login, payment, security, and paywalls remain protected.
- Saved templates are reapplied without further model requests. Pause/resume and per-rule checkboxes restore hidden content. Cookie overlays are hidden visually without clicking consent controls.
- Large or CPU-bound models can take time. Chromium runs Ollama requests in a dedicated worker inside an offscreen extension page, so slow server responses can finish after the popup closes. Requests have a 120-second per-batch timeout and a four-minute total analysis limit. Failed automatic attempts are not retried in a loop.
- Internal browser pages, extension stores, PDFs, file URLs, cross-origin iframe contents, and shadow DOM are not supported.

**Privacy:** candidate snippets may contain personal information and are sent to the provider you choose. Ollama address/model settings and cloud API keys stay in local extension storage, which is not synced or encrypted. Connection settings and keys are not shared with page scripts.

## Build from source

Requires Node.js 22.12+ and Bun. Chromium browsers must be version 116 or newer.

```sh
git clone https://github.com/Omegadarling/unclutter-ollama.git
cd unclutter-ollama
bun install --frozen-lockfile
bun run check
bun run build
bun run zip
```

When Bun is unavailable, `npx --yes bun` can run the same commands, for example `npx --yes bun run build`. Chromium files are in `.output/chrome-mv3/`. Load that folder unpacked. After rebuilding, click **Reload** on the extension card and refresh website tabs. No background development server is needed for production builds.

Firefox 140+ can use `bun run build:firefox`, then load `.output/firefox-mv2/manifest.json` as a temporary add-on via `about:debugging`. Permanent Firefox installation requires Mozilla signing.

## Development

Read [PROJECT_NOTES.md](PROJECT_NOTES.md) before editing. It records the module map, build commands, constraints, and known limitations. Version 0.4.0 adds runtime Ollama settings, model-availability checks, structured local classifications, and conservative response validation.

Checks use synthetic fixtures and mock servers without credentials or paid inference. CodeGraphContext and GitNexus can index the project locally; generated graphs are ignored and should not be published. Builds and checks run locally; this fork does not require GitHub Actions.

## License and attribution

[MIT](LICENSE). Original Unclutter by [Kitze](https://kitze.io/) ([upstream source](https://github.com/kitze/unclutter)). This fork preserves the upstream copyright and license.

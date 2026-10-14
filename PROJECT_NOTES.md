# Project notes

Read this file before changing code or adding features.

## Purpose

Unclutter Ollama is an MIT-licensed fork of kitze/unclutter. It adds user-configured Ollama inference to the existing reversible page-clutter hiding extension. Addresses and model names are entered in the popup and saved only in browser local extension storage. Public source, examples, metadata, and release files must contain no private infrastructure settings.

## Organization

- `lib/dom.ts`: bounded candidate extraction, protected content, selector validation, and reversible hiding.
- `lib/page-context.ts`: template identification.
- `lib/model.ts`: settings and shared profile/schema definitions.
- `lib/providers.ts` and `lib/jev.ts`: existing Gateway and TypeSafe providers.
- `lib/ollama.ts`: configurable Ollama endpoint, streaming structured classifications in batches of eight, and model availability checks.
- `lib/ollama-executor.ts` and `entrypoints/ollama-offscreen/`: Chromium offscreen document plus dedicated Web Worker for slower local inference; Firefox MV2 executes directly.
- `entrypoints/background.ts`: local storage, trusted popup messages, provider dispatch, job deduplication, and cache writes.
- `entrypoints/cleaner.content.ts`: page lifecycle and application of saved rules; never receives credentials or the Ollama address.
- `entrypoints/popup/`: controls and connection forms.
- `tests/`: synthetic checks; no real browsing or credentials.

## Build and validation

Node 22.12+ and Bun are required. If Bun is absent, use `npx --yes bun install --frozen-lockfile`, then `npx --yes bun run check`, `npx --yes bun run build`, and `npx --yes bun run build:firefox`. Chromium output is `.output/chrome-mv3/` and can be loaded unpacked in Brave. Keep generated code graphs and build outputs ignored.

## Constraints and lessons

- Preserve useful content, forms, authentication, payments, and paywalls; model output cannot supply selectors or code.
- Ollama classification must be complete, validated, and conservative; malformed or failed inference keeps existing rules.
- Configure the address and model at runtime. Never put user settings or secrets in source, build flags, screenshots, or release metadata.
- Remote Ollama must be reachable from the browser and allow the extension origin when required; document generic setup only.
- Local models can load slowly. The Chromium offscreen worker avoids the service-worker initial-fetch deadline; bound each request to 120 seconds and the overall analysis to 240 seconds. Do not return partial batch results. Model-reported confidence is not calibrated accuracy.
- Explicit URL ports 80 and 443 must survive repeated normalization; URL alone strips them and can accidentally introduce port 11434 on later validation.
- The background listener must ignore the private offscreen message channel so it does not race the worker reply. Share document creation/cleanup across concurrent tasks.
- CodeGraphContext and GitNexus support navigation; incomplete graph results do not establish missing dependencies.
- PowerShell `Copy-Item -LiteralPath` does not expand wildcards; enumerate files before copying.

## Current work

Version 0.4.0 adds configurable Ollama support. Automated provider, settings, popup, and executor checks use synthetic data. Live inference against a user server is separate from package validation.

## Tooling status

CodeGraphContext indexed the source successfully. GitNexus analysis was attempted locally with larger memory pools and without full-text indexing, but the Windows native analyzer crashed before completing the graph. Do not claim an index exists or infer safety from missing graph matches; use source inspection and behavioral checks until the analyzer is repaired.

The trusted popup UI may also be opened as an extension tab. Route it by the exact extension popup URL before treating sender.tab as a content-script message. Webpage messages must still pass frame/origin validation.

## Release validation

Version 0.4.0 passed 56 automated tests plus typecheck, lint, and format checks. Chromium MV3 and Firefox MV2 production builds succeeded. An isolated Brave profile verified blank defaults, saved connection and model availability, a 35-second delayed synthetic Ollama response with the popup closed, article protection, retained cached rules after malformed reanalysis, and pause/resume. The browser check used a synthetic server/model; no user infrastructure or real model inference was used. The extension ZIP includes the upstream MIT license.

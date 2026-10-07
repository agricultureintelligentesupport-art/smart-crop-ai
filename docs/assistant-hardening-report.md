# `/api/assistant` LLM pipeline — hardening & verification report

> **FOLLOW-UP (2026-10-07, second pass) — provider routing update.** The
> pipeline is now **Gemini-only** and the leaf-cropping step is gone:
>
> 1. **Hugging Face soft-block** — `const ENABLE_HUGGINGFACE = false` in
>    `src/lib/assistant/providers.ts` (with a per-deployment
>    `ENABLE_HUGGINGFACE=1/0` override read only by `isHuggingFaceEnabled()`).
>    With the flag off no token is resolved and no Hugging Face request is
>    built: the MobileNetV2 fallback and the Step 2 text model are skipped
>    without warnings, and `503 MISSING_KEYS` is decided by the Gemini key.
>    Nothing was deleted — the two stages are still covered by the test suite,
>    which pins the flag ON for that purpose.
> 2. **Leaf cropping removed** — the DETR-ResNet-50 detector step and the
>    `sharp` crop are gone from `/api/assistant` (the route no longer imports
>    `sharp` or `leaf-detect`). `preprocessing` keeps its wire contract (image
>    responses only) and always reports `status: "skipped"`.
> 3. **Randomized key rotation** — `shuffleGeminiKeyPool()` (Fisher–Yates) draws
>    a fresh permutation per request: every configured key is in the draw, no
>    key repeats inside one cycle, and consecutive requests do not all start on
>    the same credential. The same draw is used by `/api/leaf-diagnose`, the
>    daily-task generator and the `/api/health/gemini` probe (which lists pool
>    names in one such draw).
> 4. **60 s global deadline** — `GLOBAL_DEADLINE_MS = 60_000` (was 45 s); the
>    8 s per-attempt window is unchanged. The 503
>    `{ code: "DEADLINE_EXCEEDED" }` answer now needs a little head-room in the
>    platform limit (`maxDuration = 65` where the plan allows it) so the route's
>    own response wins the race with Vercel's 60 s kill.
>
> Everything below describes the state after the FIRST pass; where the two
> disagree (rotation order, 45 s, Step 0/leaf cropping, required variables), this
> banner wins. Verified after the second pass: `npx tsc --noEmit` clean,
> `npm run lint` 0 errors, `npm run test:unit` **799/799**.

**Scope** — the Hugging Face + Gemini pipeline behind `POST /api/assistant`, its
sibling key consumers (`/api/leaf-diagnose`, the daily-task generator,
`tools/check-gemini-models.mjs`) and two new operational probes under
`/api/health/*`.

**Status** — implemented and verified in this repository: `npx tsc --noEmit`
clean, `npm run lint` 0 errors, `npm run test:unit` **795/795**.
**No secret value appears in this report** — only variable *names*, status
codes and booleans.

---

## 1. Environment variables found

### Assistant pipeline (server-only)

| Name | Read by | Role / status |
| --- | --- | --- |
| `HUGGINGFACE_API_KEY` | Step 0 detector, Step 1 MobileNetV2 fallback, Step 2 primary text model | **The one and only** Hugging Face name. Resolved **trimmed** (a token pasted with a trailing newline now works). No alias, no hardcoded fallback. |
| `HF_TOKEN` | — | **REMOVED as an alias** (`HF_TOKEN_ENV_VARS` deleted). It is still mentioned in the repo only to say it is *not* read. |
| `GEMINI_API_KEY` | Steps 1 + 3 | Key pool, base variable. |
| `GEMINI_API_KEY_1…N` | Steps 1 + 3 | Numbered variants (values may themselves be comma-separated pools). |
| `GEMINI_API_KEY_4` | Steps 1 + 3 | **Priority key — FIRST in rotation.** |
| `GEMINI_API_KEYS` | Steps 1 + 3 | LEGACY comma-separated pool; still read, appended **last**, deprecation logged once per process. |
| `GEMINI_MODEL` | `gemini-models.ts` | Optional pin for the head of the model chain. |
| `HF_VISION_MODEL`, `HF_LEAF_DETECT_MODELS` | Step 0/1 | Optional model-id overrides. |
| `HEALTH_SECRET` | `src/lib/assistant/health.ts` | **NEW / REQUIRED** — guards `GET /api/health/hf` and `GET /api/health/gemini`. |

Other environment names found in the repo and deliberately untouched:
`OPENAI_API_KEY` / `OPENAI_MODEL` (daily tasks), `CRON_SECRET`,
`FIREBASE_DATABASE_URL` / `FIREBASE_DATABASE_AUTH`, `NEXT_PUBLIC_FIREBASE_*`,
`NEXT_PUBLIC_AUTH_BACKEND`, `CDSE_*` (Copernicus field data),
`DAILY_TASK_CONTEXTS`, and the removed `CODECRAFT_*` leftovers.

`src/lib/assistant/providers.ts` now exports the canonical list:

```ts
REQUIRED_ENV_VARS = ["GEMINI_API_KEY_4", "GEMINI_API_KEY", "HUGGINGFACE_API_KEY", "HEALTH_SECRET"]
```

## 2. Final Gemini rotation order (one source of truth)

`resolveGeminiKeyPool()` in `src/lib/assistant/providers.ts` — and **the same
function** is now used by `/api/assistant`, `/api/leaf-diagnose`, the daily-task
generator and the `check:models` CLI:

1. `GEMINI_API_KEY_4` — usually a different Google project, therefore its own
   daily quota; the request starts where the freshest budget is.
2. `GEMINI_API_KEY` (base).
3. `GEMINI_API_KEY_1`, `_2`, `_3`, `_5`, … in **numeric** order.
4. `GEMINI_API_KEYS` (legacy comma pool) — last.

Values are trimmed; comma-separated pools are flattened and named `VAR#1`,
`VAR#2`; duplicates are dropped first-wins. If `GEMINI_API_KEY_4` is absent its
**name** is logged as missing once per process and the rotation continues.

**Per-request behaviour (model-first, key-second).** For each model in the
chain the keys are tried in the order above:

* `429` / `RESOURCE_EXHAUSTED` / daily quota → the **(key name, model)** pair is
  parked in memory for **10 minutes** (another model on the same key is still
  tried), then the next key; when every key is parked for a model, the next
  model is tried.
* `400 API_KEY_INVALID` / `403` → the **key** is parked for **60 minutes** and
  skipped entirely.
* `503` / `5xx` / network error / 8 s attempt timeout → the **same key is
  retried once**, then the next key.
* a model id missing from that key's cached `GET /v1beta/models` catalog (1 h
  TTL, fetched per key) → the (key, model) pair is skipped without a round-trip.
* `404` / model-not-found → the next **model**.

Success is logged with names only:

```
Gemini OK: GEMINI_API_KEY_4 / gemini-3.8-flash
```

## 3. Model chain

`gemini-3.8-flash` → `gemini-3.5-flash` → `gemini-3.5-flash-lite` →
`gemini-2.5-flash` → `gemini-flash-latest`
(`GEMINI_MODEL` may pin the head; a pinned id is sent without `thinkingConfig`).

Thinking payloads are per generation: `thinkingLevel: "low"` for the 3.x ids
and the rolling alias, `thinkingBudget: 0` for `gemini-2.5-flash` — the wrong
shape is a 400, which is why it is asserted in the model tests.

⚠️ `gemini-2.5-flash` is in the chain because the specification mandates it. It
is refused for *new* Google API keys and Google retires it **2026-10-20**
(today is 2026-10-07). This is handled two ways: the per-key 1-hour catalog
skips it for keys that cannot see it, and if it disappears globally the 404
simply advances the chain. If you want to stop probing it at all, pin
`GEMINI_MODEL` or drop it from `GEMINI_FALLBACK_MODELS`.

## 4. Timeouts

| Guarantee | Value | Enforced by |
| --- | --- | --- |
| Per-attempt window | **8 s** | `PER_ATTEMPT_TIMEOUT_MS` + one `AbortController` per round-trip (`fetchWithAttemptTimeout`) |
| Whole-request ceiling | **45 s** | one `RequestDeadline` created at the top of the handler, passed to every stage/model/key |
| Stage minimum budget | 1.2 s | a stage is not started (and rotation stops) below it |
| Platform limit | 60 s | `maxDuration = 60` unchanged — the 45 s ceiling makes it unreachable |

When the 45 s deadline fires the route stops calling upstreams and answers:

```
HTTP 503 { "error": "الخدمة مشغولة حالياً، حاول بعد قليل",
           "code": "DEADLINE_EXCEEDED", "reply": "…" }
```

The old numbers (replaced): `UPSTREAM_TIMEOUT_MS = 25 s` per fetch,
`GEMINI_TIMEOUT_MS = 18 s` for the whole Gemini chain, `LEAF_DETECT_TIMEOUT_MS
= 9 s`. **Worst case those could not be bounded**: the Hugging Face chain alone
was 3 models × 25 s = 75 s, i.e. a slow router could push the function past
Vercel's 60 s limit. That is structurally impossible now.

## 5. 402 / 401 / 429 / 5xx handling on Hugging Face

* `401` → the token is rejected: status + short, redacted message are logged and
  the stage falls through to Gemini (a different model id cannot fix a token).
* `402` → `hfCreditCircuit.trip()`: the **whole HF chain is skipped in memory
  for 10 minutes**; the request goes straight to Gemini. (Old behaviour: the
  402 was re-discovered on *every* request.)
* `429` / `5xx` → status + short message logged, then the **next provider**
  (next model id, which the router resolves to a different inference provider).
* `404` / `model_not_supported` / gated / empty choices → walk the chain as
  before; on the last id the summary lists every id that was tried.
* network error / 8 s timeout → fall through to Gemini.

Request shape (unchanged, verified): `POST
https://router.huggingface.co/v1/chat/completions`, `Authorization: Bearer
<token>`, `Content-Type: application/json`, body `{ model, messages[system, …,
user], temperature, top_p, max_tokens, stream: false }`, reading
`choices[0].message.content`.

## 6. Health endpoints

Both are protected by `?key=<HEALTH_SECRET>` (constant-time compare), answer
`Cache-Control: no-store`, fail closed with `503 MISSING_HEALTH_SECRET` when the
secret is unset, and answer `401 UNAUTHORIZED` on a missing/wrong key.
Each probe is bounded by the shared 8 s window and spends **one real 1-token
request**. Names and booleans only — never a value.

```bash
curl "https://<host>/api/health/hf?key=$HEALTH_SECRET"
# { ok, status, latencyMs, tokenPresent, tokenPrefixOk }        tokenPrefixOk = token.startsWith("hf_")

curl "https://<host>/api/health/gemini?key=$HEALTH_SECRET"
# [ { name, ok, status, latencyMs, quotaExhausted, firstInRotation, model }, … ]
```

The Gemini probe walks `resolveGeminiKeyPool()` order and probes the **first id
of the chain**; the first entry is marked `firstInRotation: true`. A 429 parks
the (key, model) pair for 10 minutes and a 400 `API_KEY_INVALID` / 403 parks the
key for 60 minutes — exactly as a real request would.

## 7. What changed

| File | Change |
| --- | --- |
| `src/lib/assistant/providers.ts` | **New.** One home for: timeouts (8 s / 45 s / stage minimum), `RequestDeadline`, `fetchWithAttemptTimeout`, `redactSecrets` + `shortMessage`, `HUGGINGFACE_API_KEY`-only token resolver, `resolveGeminiKeyPool()` + rotation order, in-memory `GeminiKeyState` (10 min quota / 60 min invalid), `HfCreditCircuit` (10 min after 402), `HEALTH_SECRET` compare, `REQUIRED_ENV_VARS`. |
| `src/app/api/assistant/route.ts` | 8 s per attempt + one 45 s deadline (503 `DEADLINE_EXCEEDED`); HF failure policy + credit circuit; Gemini model-first rotation with parking + per-key catalog; `Gemini OK: <NAME> / <model>`; every warning/log redacted and length-capped; credentials doc updated. |
| `src/lib/assistant/gemini-models.ts` | 5-id mandated chain; per-key 1-hour catalog (`ensureCatalog` / `cachedCatalog`) alongside the existing health monitor. |
| `src/lib/assistant/health.ts` | **New.** `authorizeHealthProbe()` guard (fail-closed, constant-time, no-store). |
| `src/app/api/health/hf/route.ts`, `…/gemini/route.ts` | **New.** The two probes above. |
| `src/lib/leaf-diagnose-gemini.ts`, `src/lib/dailyTasks/ai.ts`, `tools/check-gemini-models.mjs` | Their private key resolvers were replaced by the shared `resolveGeminiKeyPool()` (they had their own, different orders). |
| `.env.example`, `README.md`, `docs/leaf-detection.md` | Rotation order, timeouts, health endpoints, `HEALTH_SECRET`, and the removal of the `HF_TOKEN` alias. |
| `test/unit/providers.unit.test.ts` (+21), `test/unit/health-endpoints.unit.test.ts` (+13) | **New** tests for the plumbing and the probes. `assistant-route`, `gemini-models`, `leaf-diagnose-route` and `leaf-diagnose-gemini` suites updated. |

## 8. Mismatches / bugs found

1. **`HF_TOKEN` alias existed and was documented.** The code did not read
   *exactly* `HUGGINGFACE_API_KEY`; a stale shell `HF_TOKEN` could silently
   shadow the configured secret. Removed. **Deployment risk:** if a Vercel
   environment only defines `HF_TOKEN`, the HF stages are now skipped
   (the assistant still answers from Gemini / the built-in formatter).
2. **Timeouts could not be bounded** (75 s HF chain worst case, 25 + 18 + 9 s
   elsewhere) — a plausible route past Vercel's 60 s limit. Replaced by the
   8 s/45 s pair.
3. **Gemini rotation was key-first and memoryless.** A key that was
   quota-exhausted on the current model burned a round-trip on *every* model,
   and every request re-discovered the same dead key. Now model-first, with
   10-minute (key, model) quota parks and 60-minute invalid-key parks.
4. **The HF chain had no provider fallback for `429`/`5xx`/`402`.** Any of them
   failed the whole Stage 2 immediately (no second provider), and a 402 was
   re-tried on every request forever. Now: 429/5xx walk the provider chain, 402
   trips a 10-minute in-memory circuit.
5. **The model chain was 3 ids, the specification requires 5** (missing
   `gemini-2.5-flash` and `gemini-flash-latest`).
6. **No health endpoints at all, and `HEALTH_SECRET` appeared nowhere** — there
   was no supported way to answer "is this deployment's key working?". Added.
7. **Secret-leak risk in diagnostics.** Gemini URLs carry `?key=<value>`, and
   warnings/logs previously echoed upstream error bodies verbatim (up to ~600
   characters). Every message that can reach a log line or the client now goes
   through `redactSecrets` + `shortMessage` (`hf_*`, `AIza*`, `key=`/`token=`/
   `access_token=`, `Bearer <token>`).
8. **Three extra copies of key resolution** (`/api/leaf-diagnose`, daily tasks,
   `check:models` CLI) with different orders — the CLI sorted alphabetically,
   the leaf route preferred the base variable. The "first key" therefore
   differed per feature. All four now share one resolver.
9. **The probes' rejection responses were cacheable** (no `Cache-Control` on
   the 503/401 guard paths) — a proxy could have cached a denial past the
   deployment fix. Fixed; found by the new endpoint tests.
10. **Cannot be verified from this sandbox:** live validity of the router model
    ids (`Qwen/Qwen3-4B-Instruct-2507`, `Qwen/Qwen2.5-7B-Instruct`,
    `Qwen/Qwen2.5-1.5B-Instruct`) and of the Gemini ids. There is no outbound
    egress to `huggingface.co` / `generativelanguage.googleapis.com` here and no
    credential may be used. The three Qwen ids are real, open, non-gated repos;
    router provider mappings change over time, which is exactly what the
    chain-walk handles. Verify in the deployment with the commands below.

## 9. Verification performed

```bash
npx tsc --noEmit          # clean
npm run lint              # 0 errors (1 pre-existing warning in an untouched component)
npm run test:unit         # 795 / 795 pass  (was 759; +34 new, 2 updated)
npm run check:models      # runs; exits 1 here because this sandbox has no GEMINI_API_KEY
```

New/updated tests cover: rotation order incl. `GEMINI_API_KEY_4` first and the
missing-name log; per-(key, model) quota parks and 60-minute invalid parks;
`503`/`5xx` retry-once-then-rotate; the 10-minute 402 circuit; per-key catalogs;
8 s attempt vs 45 s deadline (fake timers); redaction of every credential shape;
`HF_TOKEN` not being an alias; the 503 `DEADLINE_EXCEEDED` body; and both probes
(guard, shapes, rotation order, parking, `no-store`, no key value echoed).

## 10. Operator actions (Vercel → Project → Settings → Environment Variables)

1. **Set `HEALTH_SECRET`** (e.g. `openssl rand -hex 32`) — otherwise both probes
   answer `503 MISSING_HEALTH_SECRET`.
2. **Make sure the Hugging Face token is in `HUGGINGFACE_API_KEY`**; `HF_TOKEN`
   is no longer read.
3. Optional but recommended: put the freshest-quota Google project key in
   `GEMINI_API_KEY_4` so it is spent first.
4. After the next deploy:

   ```bash
   curl -s "https://<host>/api/health/hf?key=$HEALTH_SECRET"
   curl -s "https://<host>/api/health/gemini?key=$HEALTH_SECRET"
   GEMINI_API_KEY=... npm run check:models      # verifies the 5 ids against ListModels
   ```

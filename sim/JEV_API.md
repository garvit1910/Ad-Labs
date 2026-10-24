# Jev API: exact field names

Source: TypeSafe OpenAPI spec `https://api.typesafe.ai/openapi.json` (v0.2.0) and
docs.typesafe.ai (System One, Choice, Noul, Score, Request rules and errors, Models,
Jev 1.13 jaggedness), read 2026-10-24, and confirmed by a live Choice + Noul call to
`jev-1.13.0` the same day (765 input tokens, 162 ms). Wrapper: `src/jev.ts`. The request and
validated response of the last smoke call are written to `.cache/last-jev-call.json`.

## Request

`POST https://api.typesafe.ai/v1/systemone`
Headers: `Authorization: Bearer $TYPESAFE_API_KEY`, `Content-Type: application/json`.

```json
{
  "model": "jev-1.13.0",
  "state": "SHOPPER\n...",
  "questions": {
    "tap":      { "type": "choice", "instructions": "...", "criteria": { "A": "...", "B": "...", "C": "...", "none": "..." } },
    "believes": { "type": "noul",   "instructions": "...", "criteria": { "true": "...", "false": "..." } },
    "appeal":   { "type": "score",  "instructions": "...", "criteria": ["level 0", "level 1", "level 2"] }
  }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `model` | string, required | Model ID or alias. We pin `jev-1.13.0`. |
| `state` | string, object or array, required | What every question refers to. We send a string. |
| `questions` | object, required, min 1 | Question name (ours, never shown to the model) to question. |
| `questions.*.type` | `"choice"`, `"noul"`, `"score"` or `"box"` | |
| `questions.*.instructions` | string, object, array or null | The question itself. |
| Choice `criteria` | object, required, 1 to 255 keys | Option name to description (or null). Option names and descriptions are both sent to the model. |
| Noul `criteria` | object, optional | `{ "true": ..., "false": ... }`: what counts as yes and no. |
| Score `criteria` | array, required, 1 to 10 items | Ordered levels; position = score, from 0. |

## Response (200)

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "tap":      { "type": "choice", "choice": "none", "confidence": 0.7, "probabilities": { "A": 0.05, "B": 0.1, "C": 0.05, "none": 0.8 } },
    "believes": { "type": "noul", "noul": 0.62 },
    "appeal":   { "type": "score", "score": 1.7, "confidence": 0.55, "legend": { "0": "...", "1": "...", "2": "..." }, "probabilities": { "0": 0.1, "1": 0.1, "2": 0.8 } }
  },
  "usage": { "input_tokens": 120, "output_tokens": 12 }
}
```

| Field | Notes |
| --- | --- |
| `model` | The versioned ID that answered; can differ from an alias that was sent. |
| `answers.<name>` | Keyed by our question names; `type` matches the question's. |
| Choice: `choice`, `confidence`, `probabilities` | `choice` = most likely option; `probabilities` keyed by option name, sums to about 1. |
| Noul: `noul` | P(yes), 0 to 1. No `confidence` field. |
| Score: `score`, `confidence`, `legend`, `probabilities` | `score` = expected level; `legend` and `probabilities` keyed `"0"`, `"1"`, .... |
| `usage.input_tokens`, `usage.output_tokens` | Billed on input only. The JS SDK changelog allows null counts, so the schema accepts null. |

## Errors

`400` breaks a request rule (bad UTF-8, nesting over 64, non-finite numbers, `max_tokens_exceeded`) ·
`401` bad key · `413` body over 32 MiB · `415` bad `Content-Encoding` · `422` validation
(`{ "detail": [{ "loc", "msg", "type" }] }`) · `429` rate limit · `529` overloaded.
The wrapper retries 429, 529 and 5xx with exponential backoff, honouring `retry-after`;
everything else throws `JevError` with the status and body.

## Limits and model notes

- Context: 64k tokens per request (state + all questions), 32k per question (state + one question).
- Rate limits are per organisation, in tokens and requests per second (console.typesafe.ai). B1 measures ours.
- Price: $0.042 per million input tokens; output is free.
- `jev-1.14.0` shipped 2026-10-14 and `jev-latest` now points to it. We stay pinned to
  `jev-1.13.0` per the plan; switching means re-running calibration.
- Each question sees only the state and itself, never the other questions. That's why the feed
  posts live in the state (B1, `SPIKE.md`): every tap Noul and `believes` can point at them.
- 1.13 jaggedness that matters here: it reads literally, can't count, and loses accuracy as
  irrelevant state grows. The documented first-option lean didn't show up in B1 (mean P(tap) by
  position 0.29 / 0.28 / 0.28).

## Observed live (B1, about 5,700 calls)

- **Not deterministic.** The identical request varies: sd 0.011–0.018 on a Noul and 0.008–0.035 on
  a Choice probability, the same whether requests are sent one after another or together. Only
  the cache gives identical replays.
- **Resolution is 0.01.** Every probability is on a 0.01 grid (up to float rounding such as
  0.8099999999999999). Choice answers return exact 0 and 1; feed Nouls stayed within 0.06–0.73.
- **Status codes that differ from the docs.** Malformed JSON returns **422** `json_invalid`, not
  400. An unknown model returns **400** `api_usage_error`. Over 64k tokens returns 400
  `max_tokens_exceeded`. Bad key returns 401 `authentication_error`.
- **No 429s** at up to 256 requests in flight (peak about 700 req/s); `retry-after` was never seen.
  Latency p50 about 75 ms up to 32 in flight.

## Why not the JS SDK

`@typesafe-ai/sdk@0.7.0` exists (it needs Node 22 or newer, with typed answers and built-in
retries). We call the HTTP API directly so zod validates the raw response, the cache key is the
exact request body, and no dependency is added beyond the plan's list.

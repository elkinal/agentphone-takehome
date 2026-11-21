# AgentPhone Call Assistant

An MCP server that lets an AI agent place a real outbound phone call via
[AgentPhone](https://agentphone.ai), carry out a task on the call, and report
the result back through MCP and SMS.

```
MCP client -> place_call -> AgentPhone outbound call -> agent completes task
                                   |
                                   v
                     background poller watches call status
                                   |
                                   v
                 outcome extracted + SMS report sent to your phone
                                   |
MCP client -> get_call  <----------+ (also callable any time for live status)
```

## Setup

```bash
npm install
cp .env.example .env
# fill in AGENTPHONE_API_KEY (Settings -> API Keys in the AgentPhone dashboard)
# and USER_PHONE_NUMBER (where you want the result SMS sent, E.164 format)
# optionally fill in ANTHROPIC_API_KEY too -- enables the LLM outcome
# classifier and the pre-call clarification check (see below); without it,
# both fall back to simpler, less reliable built-in checks

npm run setup   # provisions/reuses a number + creates the calling agent
npm run opt-in  # interactive consent flow -- confirms USER_PHONE_NUMBER
```

`npm run opt-in` is a real, screenshot-able opt-in flow (you type your
number, read the consent language, type "yes"), used as the opt-in evidence
for AgentPhone's A2P 10DLC registration -- see below. `scripts/optin-page.html`
is the same flow as a standalone web page, if a browser screenshot reads
better to a carrier reviewer than a terminal one -- open it directly in a
browser, no server needed.

`npm run setup` is idempotent: it reuses your first existing AgentPhone
number and a "Call Assistant" agent if either already exists, otherwise it
creates them. The resulting `agentId`/`numberId` are saved to
`data/config.json`.

**SMS requires 10DLC registration.** AgentPhone requires an approved A2P/10DLC
campaign before it will send SMS to US numbers. Register at
[agentphone.ai/register](https://agentphone.ai/register) (or `POST
/v1/register`) if you haven't already -- see the banner in the AgentPhone
dashboard. Calls work immediately either way; only the final SMS report is
blocked until registration completes (the server reports this failure
clearly rather than silently dropping it -- see `smsError` below).

## Running the MCP server

```bash
npm run dev        # runs directly with tsx
# or
npm run build && npm start
```

It speaks MCP over stdio. `.mcp.json` in this repo is a working example
config for Claude Code -- open this project directory in Claude Code and
it's picked up automatically (project-scoped). It intentionally has no
`env` block: the server loads `.env` from its own project root regardless
of the client's working directory, so there's nothing else to configure.

For Claude Desktop or another client, point it at an absolute path instead:

```json
{
  "mcpServers": {
    "agentphone-call-assistant": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/agentphone-takehome/src/index.ts"]
    }
  }
}
```

(Or point `command`/`args` at `node dist/index.js` after `npm run build`.)

### Offline tests (no real calls, no cost)

```bash
npm run test:offline
```

Covers input validation (garbage/plain-digit phone numbers), idempotency,
and error handling -- everything that doesn't require placing a real,
billable phone call. Live conversation quality and outcome accuracy can
only be verified with real calls; see the CLI demo below for that.

### CLI demo (no MCP client needed)

```bash
npm run demo -- +15551234567 "Book a table for 4 this Friday between 6:30 and 7:30pm under the name Manav. Ask about outdoor seating." "Don't accept a reservation that requires a deposit"
```

This drives the same `place_call` / `get_call` code path the MCP tools use,
polls until the call ends, and prints the final transcript + outcome.

## Tools

### `place_call`

Args: `destination`, `destinationLabel` (optional, e.g. `"Luigi's Trattoria"`
-- used in the SMS report and call history instead of the raw number),
`task`, `userDetails` (object), `constraints` (string array),
`notifyPhoneNumber` (optional, defaults to `USER_PHONE_NUMBER`),
`idempotencyKey` (required). `destination`/`notifyPhoneNumber` accept plain
10-digit US numbers too -- they're normalized to E.164 before dialing.

Places a real outbound call immediately and returns `{ callId, status }`
without waiting for the call to finish. The call runs in the background;
a poller inside the server checks on it every `POLL_INTERVAL_MS` (default
5s) and sends the SMS report the moment it ends, even if nobody calls
`get_call` again.

**Idempotency:** the first request for a given `idempotencyKey` is the one
that counts -- success or failure. Re-sending the same key always returns
that original call's record and never dials again. Mint a new key for a
genuinely new attempt.

**Pre-call clarification (bonus):** before actually dialing, the task is
checked for anything essential that's missing (no date/time for a
reservation, no name to book under, no indication of who to even call).
If something's missing, `place_call` returns `{ needsClarification: true,
missingDetails: [...] }` instead of placing a call -- nothing is
persisted and the idempotency key is untouched, so the calling model can
go ask the user and retry with the same key once it has an answer. This
only runs when `ANTHROPIC_API_KEY` is set; without it, `place_call` just
proceeds to dial as before.

### `get_call`

Args: `callId`. Re-fetches the latest status/transcript from AgentPhone,
updates the stored record, and returns it in full: status, transcript,
`outcome` (`success`, `summary`, `confirmed`, `unresolved`), and whether the
report SMS went out (`smsSent` / `smsError`).

If the call is still in progress, this waits (polling every 3s, up to
~90s) for it to reach a terminal state before returning, instead of
handing back whatever status happens to be current. One `get_call` call
is enough -- no need for the calling model to build its own sleep-and-poll
loop around repeated calls to check on something still ringing.

### `list_calls` (bonus)

Args: `limit` (default 20). Lists recent calls with a one-line summary each
-- simple call history without needing to track IDs yourself.

## How the call outcome is determined

The voice call itself is handled entirely by AgentPhone's hosted LLM
(`voiceMode: "hosted"` + a per-call `systemPrompt` built from your `task`,
`userDetails`, and `constraints` -- see `src/prompt.ts`). No separate
speech/LLM pipeline runs the conversation itself, and the agent is
instructed to state the concrete result naturally as part of its own
goodbye -- it never says anything that would sound like a log line or tag
to the person on the call (an earlier version had it speak a literal
`CALL OUTCOME:` marker out loud, which worked for parsing but sounded
robotic and gave away that it wasn't a human; that's gone now).

Once a call ends, `src/llmOutcome.ts` sends the full transcript, the
original task, and the constraints to Claude (`claude-haiku-5-5`) and asks
it to classify the result as structured JSON (`success`/`summary`/
`confirmed`/`unresolved`). This replaced an earlier keyword-matching
heuristic that kept producing real false positives/negatives in testing
(e.g. "I won't be able to book" didn't match "not able"; "I'll confirm"
didn't match "confirmed") -- natural language has too many valid phrasings
for string matching to keep up with reliably. This step is optional: if
`ANTHROPIC_API_KEY` isn't set, or the call fails for any reason, it falls
back to the original keyword heuristic in `src/outcome.ts` (never a hard
dependency, never a crash).

## Failure handling

- **Call placement fails** (bad number, account not funded, etc.): recorded
  under the idempotency key as a failed call with `placementError` set; no
  retry happens automatically, but the error is visible via `get_call`.
- **Call not answered / busy / failed**: `outcome.success` is `false` and
  `summary` reflects why, straight from AgentPhone's call status.
- **SMS send fails** (e.g. 10DLC not registered): `smsSent` stays `false`
  and `smsError` holds the reason; the call's MCP result is unaffected. A
  separate, slower loop (`SMS_RETRY_INTERVAL_MS`, default 10 min) retries
  sending it for any ended call that never got its text out, so a
  multi-day external delay (like carrier registration review) resolves
  itself automatically once sending unblocks -- no need to replay old
  calls through `get_call` by hand. (The fast status-polling loop only
  touches calls still in progress, not already-ended ones.)
- **Repeated idempotency key**: always short-circuits to the original call,
  never places a second one.

## What I'd change with more time

- **Push instead of poll.** `agent.call_ended` webhooks deliver a full
  transcript plus AgentPhone's own `summary`/`callSuccessful`/`userSentiment`
  the instant a call ends, instead of polling every few seconds. I didn't
  wire this up because it needs a public HTTPS endpoint (ngrok/tunnel) for
  local dev, which felt like unnecessary setup friction for a CLI-scoped
  take-home; polling the REST API gets the same end result with zero
  infra. It's the first thing I'd swap in for lower latency and fewer wasted
  API calls.
- **Done during testing:** outcome classification moved from keyword
  matching to a real LLM pass (`src/llmOutcome.ts`) after live testing kept
  producing false positives/negatives the keyword list couldn't keep up
  with. With more time I'd add a small eval set of transcripts (including
  partial-success/ambiguous cases) to regression-test that classifier
  instead of relying on ad hoc live calls.
- **Call recording + review.** AgentPhone supports an optional recording
  add-on; surfacing `recordingUrl` through `get_call` and a simple local
  web UI for browsing call history/transcripts/recordings would make this
  feel like a real product rather than a CLI tool.
- **Concurrency/rate limits.** No handling yet for AgentPhone's per-number
  concurrent-call limit (`409`) or account concurrency cap (`429`) beyond
  surfacing the raw error as `placementError` -- worth a small retry-with-
  backoff for `429` specifically.
- **Voicemail handling.** Currently the prompt just tells the agent to hang
  up silently on voicemail; a real product would detect that distinctly
  (`disconnectionReason`) and optionally leave a tailored message.

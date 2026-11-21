# AgentPhone Call Assistant

An MCP server that lets an AI agent place a real outbound phone call via
AgentPhone, carry out a task on the call, and report back what happened —
through MCP and by text.

Ask it something like:

> "Call this restaurant and book a table for four this Friday between 6:30
> and 7:30pm under the name Manav. Ask about outdoor seating. Don't accept
> a reservation that requires a deposit."

...and it places the real call, has the conversation, and reports back
whether it worked, what was confirmed, and anything unresolved.

**Demo video:** see the Loom walkthrough for the full flow end to end.

## What I built beyond the two required tools

The brief asked for `place_call` and `get_call`. Beyond that:

- **A real LLM reads the transcript to judge the outcome**, instead of
  matching keywords. Keyword matching kept getting it wrong in testing —
  "I won't be able to book" didn't match "not able"; "I'll confirm" didn't
  match "confirmed." Claude now reads the whole call and reports exactly
  what was confirmed vs. still unresolved.
- **It checks the task makes sense before dialing.** If you ask it to
  "call them" with no real purpose, it asks for clarification instead of
  placing a pointless call — nothing gets consumed, so you just retry once
  you've got an answer.
- **A third tool, `list_calls`**, for call history — no need to track call
  IDs yourself.
- **It sounds like a person, not a script.** It never repeats itself,
  stays on the original task if the conversation drifts, and is honest if
  asked whether it's an AI.
- **A real opt-in flow for SMS**, not a staged screenshot — you type your
  number and see the actual consent text before anything is saved.

## What I changed after testing it live

I placed real calls, listened to how they actually went, and fixed what I
found:

- It used to speak a literal `"CALL OUTCOME:"` tag out loud to make
  parsing easier — but the person on the call would hear that and know
  something odd was going on. Removed it; the result now comes from the
  agent's own natural goodbye.
- It said "no deposit needed" in almost every turn of one call. Added a
  rule against repeating itself.
- It asked the same deposit question twice in slightly different words
  after already getting an answer. Tightened the no-repeat rule to also
  cover re-asking a question, not just restating a fact.
- A restaurant once offered a table for five instead of the four I'd
  asked for; the agent correctly declined, then gave up on the whole call
  instead of going back to confirm whether four was available. Added a
  rule to stay on the original task.
- Through an actual MCP client, `get_call` returned instantly with
  whatever status was current, so the client built its own clunky
  sleep-and-check loop to wait for the call to finish. Made `get_call`
  wait internally instead — one call is enough.
- Tuned voice speed, interruption sensitivity, and transcription accuracy
  after live calls showed cut-off and mis-heard speech.

## Limitations, and what I'd build next

- **SMS delivery is currently blocked** on AgentPhone's own A2P/10DLC
  carrier registration review for my number — external, not a code gap
  (shown in the demo: the failure is reported clearly, not hidden).
- **Push instead of poll.** Status checks currently poll the API; with
  more time I'd switch to AgentPhone's `agent.call_ended` webhook for
  lower latency and fewer wasted requests.
- **Call recording + a simple history UI**, instead of reading JSON.
- **A small eval set of transcripts** to regression-test the outcome
  classifier, instead of relying on ad hoc live calls.
- **Rate limit / concurrency handling** for AgentPhone's per-number and
  account-level call limits beyond surfacing the raw error.

---

## Technical details

### Setup

```bash
npm install
cp .env.example .env
# fill in AGENTPHONE_API_KEY (Settings -> API Keys in the AgentPhone dashboard)
# and USER_PHONE_NUMBER (where you want the result SMS sent, E.164 format)
# optionally fill in ANTHROPIC_API_KEY too -- enables the LLM outcome
# classifier and the pre-call clarification check above; without it,
# both fall back to simpler, less reliable built-in checks

npm run setup   # provisions/reuses a number + creates the calling agent
npm run opt-in  # interactive consent flow -- confirms USER_PHONE_NUMBER
```

`npm run opt-in` is a real, screenshot-able opt-in flow (you type your
number, read the consent language, type "yes"), used as the opt-in
evidence for AgentPhone's A2P 10DLC registration. `scripts/optin-page.html`
is the same flow as a standalone web page, if a browser screenshot reads
better to a carrier reviewer than a terminal one — open it directly in a
browser, no server needed.

`npm run setup` is idempotent: it reuses your first existing AgentPhone
number and a "Call Assistant" agent if either already exists, otherwise
it creates them. The resulting `agentId`/`numberId` are saved to
`data/config.json`.

**SMS requires 10DLC registration.** AgentPhone requires an approved
A2P/10DLC campaign before it will send SMS to US numbers. Register at
[agentphone.ai/register](https://agentphone.ai/register) (or `POST
/v1/register`) if you haven't already — see the banner in the AgentPhone
dashboard. Calls work immediately either way; only the final SMS report
is blocked until registration completes (the server reports this failure
clearly rather than silently dropping it — see `smsError` below).

### Running the MCP server

```bash
npm run dev        # runs directly with tsx
# or
npm run build && npm start
```

It speaks MCP over stdio. `.mcp.json` in this repo is a working example
config for Claude Code — open this project directory in Claude Code and
it's picked up automatically (project-scoped). It intentionally has no
`env` block: the server loads `.env` from its own project root regardless
of the client's working directory, so there's nothing else to configure.

For Claude Desktop or another client, point it at an absolute path
instead:

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

#### Offline tests (no real calls, no cost)

```bash
npm run test:offline
```

Covers input validation (garbage/plain-digit phone numbers), idempotency,
and error handling — everything that doesn't require placing a real,
billable phone call. Live conversation quality and outcome accuracy can
only be verified with real calls; see the CLI demo below for that.

#### CLI demo (no MCP client needed)

```bash
npm run demo -- +15551234567 "Book a table for 4 this Friday between 6:30 and 7:30pm under the name Manav. Ask about outdoor seating." "Don't accept a reservation that requires a deposit"
```

This drives the same `place_call` / `get_call` code path the MCP tools
use, polls until the call ends, and prints the final transcript +
outcome.

### Tools

#### `place_call`

Args: `destination`, `destinationLabel` (optional, e.g. `"Luigi's
Trattoria"` — used in the SMS report and call history instead of the raw
number), `task`, `userDetails` (object), `constraints` (string array),
`notifyPhoneNumber` (optional, defaults to `USER_PHONE_NUMBER`),
`idempotencyKey` (required). `destination`/`notifyPhoneNumber` accept
plain 10-digit US numbers too — they're normalized to E.164 before
dialing.

Places a real outbound call immediately and returns `{ callId, status }`
without waiting for the call to finish. The call runs in the background;
a poller inside the server checks on it every `POLL_INTERVAL_MS` (default
5s) and sends the SMS report the moment it ends, even if nobody calls
`get_call` again.

**Idempotency:** the first request for a given `idempotencyKey` is the
one that counts — success or failure. Re-sending the same key always
returns that original call's record and never dials again. Mint a new
key for a genuinely new attempt.

**Pre-call clarification:** before actually dialing, the task is checked
for anything essential that's missing (no date/time for a reservation, no
name to book under). If something's missing, `place_call` returns `{
needsClarification: true, missingDetails: [...] }` instead of placing a
call — nothing is persisted and the idempotency key is untouched, so the
calling model can go ask the user and retry with the same key once it
has an answer. This only runs when `ANTHROPIC_API_KEY` is set; without
it, `place_call` just proceeds to dial as before.

#### `get_call`

Args: `callId`. Re-fetches the latest status/transcript from AgentPhone,
updates the stored record, and returns it in full: status, transcript,
`outcome` (`success`, `summary`, `confirmed`, `unresolved`), and whether
the report SMS went out (`smsSent` / `smsError`).

If the call is still in progress, this waits (polling every 3s, up to
~90s) for it to reach a terminal state before returning, instead of
handing back whatever status happens to be current. One `get_call` call
is enough — no need for the calling model to build its own sleep-and-poll
loop around repeated calls to check on something still ringing.

#### `list_calls`

Args: `limit` (default 20). Lists recent calls with a one-line summary
each — simple call history without needing to track IDs yourself.

### How the call outcome is determined

The voice call itself is handled entirely by AgentPhone's hosted LLM
(`voiceMode: "hosted"` + a per-call `systemPrompt` built from your `task`,
`userDetails`, and `constraints` — see `src/prompt.ts`). No separate
speech/LLM pipeline runs the conversation itself, and the agent is
instructed to state the concrete result naturally as part of its own
goodbye — it never says anything that would sound like a log line or tag
to the person on the call.

Once a call ends, `src/llmOutcome.ts` sends the full transcript, the
original task, and the constraints to Claude (`claude-haiku-5-5`) and
asks it to classify the result as structured JSON
(`success`/`summary`/`confirmed`/`unresolved`). This step is optional: if
`ANTHROPIC_API_KEY` isn't set, or the call fails for any reason, it falls
back to a keyword heuristic in `src/outcome.ts` (never a hard dependency,
never a crash).

### Failure handling

- **Call placement fails** (bad number, account not funded, etc.):
  recorded under the idempotency key as a failed call with
  `placementError` set; no retry happens automatically, but the error is
  visible via `get_call`.
- **Call not answered / busy / failed**: `outcome.success` is `false` and
  `summary` reflects why, straight from AgentPhone's call status.
- **SMS send fails** (e.g. 10DLC not registered): `smsSent` stays `false`
  and `smsError` holds the reason; the call's MCP result is unaffected. A
  separate, slower loop (`SMS_RETRY_INTERVAL_MS`, default 10 min) retries
  sending it for any ended call that never got its text out, so a
  multi-day external delay (like carrier registration review) resolves
  itself automatically once sending unblocks — no need to replay old
  calls through `get_call` by hand. (The fast status-polling loop only
  touches calls still in progress, not already-ended ones.)
- **Repeated idempotency key**: always short-circuits to the original
  call, never places a second one.

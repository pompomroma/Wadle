# Wadle

Describe software, attach files, get something that actually runs.

Wadle is a web app for vibe programming. You write what you want — optionally
attaching files, including compiled ones like `.exe`, `.gba` or `.zip` — and it
builds the thing, runs it, tests it, and keeps repairing it until it works.

The part that matters: **it does not hand you something that doesn't work.**
Every build is gated on verified execution. If a product compiles cleanly and
then does nothing at runtime, that is a failure, and the loop goes back to work.
If it can't get there within its budget, you get a report of exactly which
checks are still failing — not a broken artifact.

---

## Quick start

```bash
git clone https://github.com/pompomroma/Wadle.git
cd Wadle
cp .env.example .env       # then put your model key in it
pnpm setup                 # installs, then checks your machine is ready
pnpm dev                   # UI on :5173, API on :5174
```

`pnpm setup` runs a preflight that checks Node and pnpm versions, dependencies,
your `.env`, and whether the port is free — and tells you the exact command to
fix anything it finds, rather than failing later with a stack trace. Run it on
its own any time with `pnpm preflight`.

`pnpm dev` builds the UI on the fly. To run it as a single server instead,
build first — `dist/` is not in the repository, so a fresh clone has no UI
until you do:

```bash
pnpm build && pnpm start   # everything on :5174
```

Or with the full toolchain set and real isolation:

```bash
NVIDIA_API_KEY=... docker compose up --build
```

Check what your machine can actually do:

```bash
pnpm doctor
```

That prints a live capability matrix — which languages can be built and
verified here, which binary targets are available, which conversion tools are
installed. Anything missing is reported as missing, with what it degrades to.

---

## The model

Wadle runs on **NVIDIA Nemotron 3 Ultra** (`nvidia/nemotron-3-ultra-550b-a55b`)
via NVIDIA NIM — 550B parameters total, 55B active, 1M-token context.

Point it somewhere else with one variable:

```bash
LLM_BASE_URL=http://localhost:11434/v1    # Ollama, llama.cpp, vLLM — anything
LLM_MODEL=qwen2.5-coder:32b               # OpenAI-compatible endpoints all work
```

### Credits and payment

Wadle has **no credit system, no metering, no quotas and no billing**. There is
no paywall to remove because none was built.

What Wadle cannot do is make someone else's API free. If you use NVIDIA's hosted
endpoint, NVIDIA's rate limits apply — they are theirs, not ours. Pointing
`LLM_BASE_URL` at a model on your own machine gives you a path with no provider
limits and no per-token cost at all.

### About the TOPS figure

The rail shows a performance tier in TOPS. It is a **configured constant**, and
the UI says so.

TOPS — tera-operations per second — is a hardware metric. It describes silicon:
an NPU, a Jetson module, a GPU. Language models don't have one. Anthropic
publishes Claude Opus 5's model id, context window, output limit and price per
million tokens; there is no TOPS rating to read, and therefore nothing to
double. Rather than invent a derivation and present it as fact, the number lives
in one place:

```ts
// apps/server/src/config/model.ts
export const PERFORMANCE_TOPS = 4000;
```

Change it to whatever you want displayed. Every other figure on that panel is a
real, checkable property of the deployed model.

---

## Access and public URLs

Wadle runs code written by a language model, so a reachable instance is always
gated. You cannot accidentally publish an open one:

| Situation | Gate |
|---|---|
| Bound to loopback, no token set | **Open** — local development |
| Bound to anything else (`HOST=0.0.0.0`, a LAN address, a hostname) | **Token required**, generated automatically |
| A tunnel is enabled | **Token required**, generated automatically |
| `WADLE_AUTH_TOKEN` is set | **Token required**, everywhere including locally |

When a token is in force it is printed at startup, stored in
`data/.auth-token`, and baked into the link you're given:

```
Open      http://localhost:5174/?t=Xq3nT7...
Access    token required — bound to 0.0.0.0, which is reachable beyond this machine
```

Open that link once and the browser moves the token into `sessionStorage` and
strips it from the address bar, so it stops travelling in URLs and stays out of
history. API clients can send it as `Authorization: Bearer <token>` instead.
Only `/api/health` and the UI shell are ungated.

### Getting a public link

First install `cloudflared` — without it there is no tunnel and no public URL:

```bash
brew install cloudflared                     # macOS
# Linux/Windows: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
```

Then:

```bash
WADLE_TUNNEL=cloudflare pnpm start
```

`pnpm start` runs the preflight and builds the UI for you. This publishes a
temporary `https://….trycloudflare.com` URL via a Cloudflare quick tunnel — no
Cloudflare account needed. Enabling it forces the token gate on, and the full
link including the token is printed at startup.

If `cloudflared` is missing, Wadle says so and keeps serving locally instead of
failing.

Quick tunnels are ephemeral: **the hostname changes every restart.** That's
right for sharing a session and wrong for anything permanent. For a stable
address, deploy the container somewhere you control and put your own hostname
in front of it:

```bash
docker compose up -d --build     # then point your domain at :5174
```

Set `WADLE_AUTH_TOKEN` to a value you choose when you do that, so the link
survives restarts.

### Running without the gate

If you want a reachable instance with no token at all:

```bash
WADLE_ALLOW_OPEN=1 WADLE_TUNNEL=cloudflare pnpm start
```

Be clear about what this does: **anyone who reaches that URL can run code on
your machine.** Wadle builds and executes programs, so an ungated public
instance is an open remote-code-execution endpoint. It is never the default, the
startup banner says so in red, and setting `WADLE_AUTH_TOKEN` overrides it. It
exists because it is your machine and your call — not because it is a good idea.

---

## Workspaces

Each workspace is a session slot holding one evolving product.

Requests **stack**. Queue five adjustments while the first is still building;
they run in order, and each is applied to the state the previous one produced.
Every completed request becomes a restorable revision, so an adjustment that
takes the product somewhere you didn't want is one click to undo.

---

## What happens to a request

```
your request + attachments
   ↓
spec        machine-checkable acceptance criteria are extracted
plan        stack, file tree, commands
generate    real files written to disk
verify      install → build → run → test → check every criterion
   ↓            │
   │            └── something failed? → diagnose from the exact stderr,
   │                                     patch, and verify again
   ↓
deliver     only when every check passes
```

### The gate

A product ships only if all of these hold:

- the build exits 0
- the artifact actually starts — a server binds and answers, a binary exits 0
- output is non-trivial: a blank page, an empty file, or a program that prints
  nothing **fails**
- every extracted acceptance criterion passes
- generated tests pass

This is deliberately strict, because "builds fine, does nothing" is the single
most common way generated software is wrong.

### When it can't finish

The loop runs until every check passes, bounded by a budget you control
(`AGENT_MAX_ITERATIONS`, `AGENT_WALL_CLOCK_MS`, `AGENT_TOKEN_CEILING`). Loop
state is checkpointed per revision, so hitting a limit resumes rather than
restarts. Set `maxIterations` to `Infinity` if you want it genuinely unbounded.

Under every setting, **a product that fails the gate is never delivered.**

---

## Files

### What you get back

A web product is served at a real link — `/p/<slug>/` — with live state, not a
static snapshot. Anything else comes back as a file you can download.

### What Wadle does with what you upload

| You upload | What happens |
|---|---|
| `.zip`, `.tar`, `.gz`, source trees | Full round-trip: unpack, edit anything inside, repack |
| `.json` `.yaml` `.toml` `.ini` `.xml` `.csv` `.env` | Parse, edit, convert between any of them |
| `.docx` `.xlsx` `.pptx` `.odt` `.pdf` | Read and convert, via LibreOffice |
| `.png` `.jpg` `.gif` | Decode, transform, re-encode |
| `.exe` `.dll` | Read headers, sections, imports/exports, resources; rewrite version metadata and embedded resources; rebuild with a valid checksum |
| `.gba` | Read and rewrite the cartridge header with a correct complement check, extract graphics and palettes, generate and apply IPS/UPS/BPS patches |
| `.elf` `.so` `.wasm` | Structural inspection |

Files are identified by **content**, not extension. A `.zip` renamed to `.exe`
is handled as a zip.

### What it will not do

Two things, stated plainly because guessing wrong wastes your time:

**It will not decompile a binary back into editable source.** You can inspect an
uploaded `.exe` or `.gba`, patch its structured regions, and generate a
distributable patch. You cannot hand it a compiled game and ask it to rewrite
the gameplay — that is decompilation-grade work, not a prompt. ROM hacks are
made here the way they are actually made: by patching bytes.

**Uploaded binaries are never executed.** They are analysed statically. Only
code Wadle generates is ever run.

### Format conversion

Three outcomes, and the distinction is the point:

- **Mechanical** — a real transformation exists. `JSON→YAML`, `DOCX→PDF`,
  `PNG→JPEG`, extract-and-repack. Runs immediately.
- **Generative** — no mechanical mapping exists, but the target can be *built*.
  "Turn this `.ini` into an `.exe`" has no byte-level meaning; what it can
  honestly mean is "write me a real program that reads this config and compile
  it". Wadle generates that program, builds it, and **runs it** before delivery.
- **Refused** — neither applies, and it says so.

It never renames a file and calls it converted.

---

## Sandboxing

Wadle executes code written by a language model. That is what it is for, so the
containment is layered rather than assumed:

1. **The container** — the real boundary. `docker compose` drops all
   capabilities, forbids privilege escalation, and caps memory and process count.
2. **Path confinement** — every model-supplied path is resolved and checked
   against the workspace root. Absolute paths are refused rather than quietly
   reinterpreted. Archive entries that escape their extraction root are refused.
3. **A minimal environment** — generated code inherits none of the host's
   variables. Your API key is not visible to it. There is a test asserting this.
4. **Resource limits** — address space, file size and process count caps, plus a
   wall-clock timeout that kills the whole process group.
5. **Network isolation** — generated processes run under `unshare -n` where the
   kernel allows it. Only dependency installation is granted network access.

Running bare metal you get layers 2–5. `pnpm doctor` tells you which are active.

---

## Secrets

The NVIDIA key belongs in `.env`, which is gitignored. `.env.example` is the
committed template.

```bash
pnpm secrets:scan                     # scan tracked files
git config core.hooksPath .githooks   # block leaks at commit time
```

The hook refuses any commit containing a credential-shaped string. If a key has
ever been pasted into a chat, an issue, or a commit — **rotate it.** Deleting
the line does not un-leak it.

---

## Layout

```
apps/server/   Fastify + SQLite. The API, the agent loop, the sandbox.
  src/agent/     prompts, project file ops, the verification gate, the loop
  src/formats/   sniffing, archives, data conversion, the conversion router
  src/llm/       streaming OpenAI-compatible client
  src/sandbox/   constrained execution, capability probing
  src/runtime/   the per-workspace queue, preview servers
apps/web/      React + Vite front end
toolbox/       Python: PE, GBA, IPS/UPS/BPS, PNG. Standard library only.
```

## Development

```bash
pnpm dev          # server + UI with hot reload
pnpm test         # the suite
pnpm typecheck
pnpm doctor       # what this machine can do
```

The tests worth knowing about live in `apps/server/test/`: `gate.test.ts` runs
real programs and asserts a do-nothing product is rejected; `loop.test.ts`
asserts the loop repairs a deliberately broken first attempt and that an
unfixable one delivers nothing; `security.test.ts` covers path traversal, zip
slip, environment isolation and timeouts.

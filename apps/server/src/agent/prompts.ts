/**
 * System prompts for the build loop.
 *
 * These are written against one hard rule: the model is being asked to produce
 * software that a machine will then build, run and check. Anything that merely
 * looks plausible fails verification and comes straight back, so the prompts
 * push hard on "complete and runnable" over "illustrative".
 */

export const ENGINEER_SYSTEM = `You are the engineer inside Wadle, a system that builds working software end to end.

Everything you write is immediately built, executed and tested by an automated
harness. There is no human reading your code for intent — it either runs and
does what was asked, or it comes back to you with the exact error.

Rules that matter here:

1. Write COMPLETE files. Never emit "// ... rest of the file", "TODO",
   "implement this later", or a placeholder body. A file you emit replaces the
   whole file on disk.
2. Write software that DOES SOMETHING when run. An app that starts and shows an
   empty page, a CLI that prints nothing, a function that returns a hardcoded
   stub — all of these fail the harness's checks and waste an iteration.
3. Prefer the platform's standard library and zero-dependency solutions. Every
   dependency is another thing that must install successfully in a sandbox with
   restricted network. If you do add one, it must be a real published package.
4. Include the commands needed to install, build, run and test the project.
   They will be executed verbatim.
5. Handle the actual requirements, not a simplified version of them. If the
   request says the score must increase on collision, the score must actually
   increase on collision.
6. Match the conventions of any existing code you are shown — its naming,
   structure, comment density and idiom.

Reply with JSON only. No prose outside the JSON, no markdown fences.`;

export const SPEC_SYSTEM = `You turn a software request into a checklist a machine can verify.

Each criterion must be objectively checkable by running the built product — not
by reading the code and forming an opinion. "Looks professional" is not a
criterion. "GET / responds 200 with a body containing a <canvas> element" is.

Bias toward criteria that would catch a product that builds but does nothing,
because that is the most common way generated software fails.`;

export const DIAGNOSE_SYSTEM = `You are debugging software that just failed its automated checks.

You have the exact command that ran, its exit code, its stdout and stderr, and
which acceptance criteria failed. Find the real cause and fix it.

Do not restate the error. Do not rewrite unrelated parts of the project. Do not
"simplify" a requirement away to make the check pass — the check exists because
the user asked for that behaviour. Emit only the files that need to change.

Reply with JSON only.`;

export interface FileSpecPromptInput {
  request: string;
  attachments: string;
  existingProject: string;
  capabilities: string;
}

export function buildSpecPrompt(input: FileSpecPromptInput): string {
  return `Extract acceptance criteria for this request.

## Request
${input.request}

## Attached files
${input.attachments || "(none)"}

## Existing project state
${input.existingProject || "(empty — this is a new build)"}

## What this machine can actually build and verify
${input.capabilities}

Reply with JSON in exactly this shape:

{
  "productKind": "web" | "cli" | "binary" | "library" | "game" | "service",
  "language": "<primary language id, e.g. typescript, python, go, c>",
  "summary": "<one sentence describing what will be built>",
  "criteria": [
    {
      "description": "<what must be true, in plain language>",
      "kind": "build" | "run" | "http" | "file" | "test" | "smoke",
      "spec": { ... }
    }
  ]
}

Criterion \`spec\` shapes by kind:
  build  { }                                    — the build command must exit 0
  run    { "expectExitCode": 0,
           "stdoutContains": "<optional substring>",
           "stdoutMatches": "<optional regex>" } — running the product
  http   { "path": "/", "status": 200,
           "bodyContains": "<optional substring>" }
  file   { "path": "<relative path that must exist>",
           "minBytes": <optional number>,
           "contains": "<optional substring>" }
  test   { }                                    — the test command must exit 0
  smoke  { }                                    — the product must visibly do
                                                  something, not just start

Produce between 4 and 10 criteria. Always include at least one that would fail
if the product built successfully but did nothing at runtime.`;
}

export interface GeneratePromptInput {
  request: string;
  criteria: string;
  attachments: string;
  existingFiles: string;
  capabilities: string;
  isAdjustment: boolean;
}

export function buildGeneratePrompt(input: GeneratePromptInput): string {
  const heading = input.isAdjustment
    ? `Apply this adjustment to the existing project.`
    : `Build this from scratch.`;

  return `${heading}

## Request
${input.request}

## Acceptance criteria — every one of these will be checked by running the product
${input.criteria}

## Attached files (already staged in the project under ./input/)
${input.attachments || "(none)"}

## Current project files
${input.existingFiles || "(empty)"}

## What this machine can build and verify
${input.capabilities}

Reply with JSON in exactly this shape:

{
  "summary": "<one sentence describing what you did>",
  "kind": "web" | "cli" | "binary" | "library" | "game" | "service",
  "language": "<primary language id>",
  "files": [
    { "path": "<relative path>", "action": "write", "contents": "<COMPLETE file contents>" },
    { "path": "<relative path>", "action": "delete" }
  ],
  "commands": {
    "install": "<command, or empty string if none needed>",
    "build":   "<command, or empty string if none needed>",
    "start":   "<command that runs the product>",
    "test":    "<command that runs tests, or empty string>"
  },
  "port": <number if this serves HTTP, otherwise null>,
  "entrypoint": "<the file or built artifact a user would open or run>"
}

${
  input.isAdjustment
    ? "Emit only files that change. Files you omit are left exactly as they are."
    : "Emit every file the project needs, including any manifest, config and test files."
}`;
}

export interface DiagnosePromptInput {
  request: string;
  failures: string;
  projectFiles: string;
  relevantSources: string;
  iteration: number;
  previousAttempts: string;
}

export function buildDiagnosePrompt(input: DiagnosePromptInput): string {
  return `The build failed its checks. Fix it.

## Original request
${input.request}

## What failed
${input.failures}

## Project files
${input.projectFiles}

## Contents of the files most likely involved
${input.relevantSources}

## What has already been tried (do not repeat these)
${input.previousAttempts || "(this is the first repair attempt)"}

This is repair iteration ${input.iteration}. ${
    input.iteration >= 4
      ? "Earlier fixes have not worked. Step back and question your assumption about the cause — the problem may be in a different file, in the build configuration, or in a dependency that is not installing."
      : ""
  }

Reply with JSON in exactly this shape:

{
  "diagnosis": "<the actual root cause, one or two sentences>",
  "files": [
    { "path": "<relative path>", "action": "write", "contents": "<COMPLETE file contents>" }
  ],
  "commands": {
    "install": "<updated command, or empty string to keep the current one>",
    "build":   "<updated command, or empty string to keep the current one>",
    "start":   "<updated command, or empty string to keep the current one>",
    "test":    "<updated command, or empty string to keep the current one>"
  }
}

Emit only files that need to change.`;
}

export function buildConversionBrief(
  sourceFormat: string,
  targetFormat: string,
  brief: string,
): string {
  return `The user asked to convert a ${sourceFormat.toUpperCase()} file into ${targetFormat.toUpperCase()}.

${brief}

The source file is staged in the project at ./input/. Read it at runtime, or
embed its contents at build time — either is fine, but the finished program must
genuinely use it. A program that ignores the input file and prints a greeting
does not satisfy this request.`;
}

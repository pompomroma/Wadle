/**
 * `pnpm doctor` — report what this host can actually do.
 *
 * The point is to fail loudly and early. If mingw-w64 is missing, you learn it
 * here rather than twenty minutes into a build that was always going to be
 * unable to produce a .exe.
 */
import { env, hasModelCredentials } from "../config/env.js";
import { MODEL_SPEC, PERFORMANCE_TOPS } from "../config/model.js";
import { toolboxCapabilities } from "../formats/toolbox.js";
import { probeCapabilities, type Capability } from "../sandbox/capabilities.js";

const GREEN = "[32m";
const RED = "[31m";
const YELLOW = "[33m";
const DIM = "[2m";
const BOLD = "[1m";
const RESET = "[0m";

function heading(text: string): void {
  process.stdout.write(`\n${BOLD}${text}${RESET}\n`);
}

function capabilityLine(capability: Capability): void {
  const mark = capability.available ? `${GREEN}✔${RESET}` : `${RED}✘${RESET}`;
  const detail = capability.available
    ? `${DIM}${capability.binaries.join(", ")}${RESET}`
    : `${YELLOW}→ ${capability.degradedTo}${RESET}`;
  process.stdout.write(`  ${mark} ${capability.label.padEnd(38)} ${detail}\n`);
}

async function main(): Promise<void> {
  process.stdout.write(`${BOLD}Wadle doctor${RESET}\n`);

  heading("Model backend");
  process.stdout.write(`  Endpoint   ${env.llm.baseUrl}\n`);
  process.stdout.write(`  Model      ${env.llm.model}\n`);
  process.stdout.write(
    `  Credential ${
      hasModelCredentials()
        ? `${GREEN}configured${RESET}`
        : `${RED}missing${RESET} — set NVIDIA_API_KEY in .env, or point LLM_BASE_URL at a local model`
    }\n`,
  );
  process.stdout.write(
    `  Context    ${MODEL_SPEC.contextWindow.toLocaleString()} tokens ` +
      `${DIM}(${MODEL_SPEC.totalParams} total / ${MODEL_SPEC.activeParams} active)${RESET}\n`,
  );
  process.stdout.write(
    `  Perf tier  ${PERFORMANCE_TOPS} TOPS ${DIM}(configured display value — see config/model.ts;\n` +
      `             no language model publishes a real TOPS figure)${RESET}\n`,
  );

  const report = await probeCapabilities(true);

  heading("Languages — can be built, run and tested here");
  report.languages.forEach(capabilityLine);

  heading("Binary targets");
  report.binaryTargets.forEach(capabilityLine);

  heading("Conversion tooling");
  report.conversion.forEach(capabilityLine);

  heading("Sandbox");
  process.stdout.write(
    `  ${report.networkIsolation ? `${GREEN}✔${RESET}` : `${YELLOW}~${RESET}`} ` +
      `Network isolation for generated code`.padEnd(40) +
      (report.networkIsolation
        ? `${DIM}unshare -n${RESET}\n`
        : `${YELLOW}→ unavailable; run via docker compose for a real boundary${RESET}\n`),
  );

  heading("Binary toolbox");
  const toolbox = await toolboxCapabilities();
  if ("available" in toolbox) {
    process.stdout.write(`  ${RED}✘${RESET} unavailable — ${toolbox.reason}\n`);
  } else {
    process.stdout.write(
      `  ${GREEN}✔${RESET} Python ${toolbox.python}` +
        `${DIM}   PE · GBA · IPS/UPS/BPS · PNG${RESET}\n`,
    );
    process.stdout.write(
      `  ${toolbox.pillow ? `${GREEN}✔${RESET}` : `${YELLOW}~${RESET}`} ` +
        `Pillow ${toolbox.pillow ? "" : `${YELLOW}→ image conversion unavailable; PNG export still works${RESET}`}\n`,
    );
  }

  heading("Limits");
  process.stdout.write(`  ${GREEN}✔${RESET} No credit system, metering, quota or billing in Wadle\n`);
  process.stdout.write(
    `  ${DIM}Provider rate limits, if any, come from ${new URL(env.llm.baseUrl).host}${RESET}\n`,
  );
  process.stdout.write(
    `  ${DIM}Agent budget: ${env.agent.maxIterations} iterations · ` +
      `${Math.round(env.agent.wallClockMs / 60000)} min · ` +
      `${env.agent.tokenCeiling.toLocaleString()} tokens${RESET}\n\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`doctor failed: ${(error as Error).stack}\n`);
  process.exit(1);
});

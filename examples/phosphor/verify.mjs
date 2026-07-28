import { chromium } from "playwright-core";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

/**
 * Verification for phosphor.html.
 *
 * The point of these checks is that the game DOES something: that the loop
 * advances, that a contact is actually consumed, that steering changes the
 * outcome, and that the canvas is not blank. Structural checks alone would
 * pass on a page that renders nothing.
 *
 * Contact placement is randomised, so Math.random is pinned before any page
 * script runs. COLS=ROWS=21; the snake starts at (6,10),(5,10),(4,10) heading
 * right, so open[] has 438 cells and (7,10) — the cell dead ahead — is at
 * index 214. A fixed 214.5/438 puts the first contact exactly there.
 *
 * With that constant the next contact also lands dead ahead at (8,10), and the
 * third does not. Two contacts 148ms apart chain inside the 2600ms combo
 * window, so the run scores 1 then +2 = 3. That figure is derived from the
 * rules in predict.mjs, not read off the game's own output.
 */
const FIXED_RANDOM = 214.5 / 438;
const STEP_MS = 148;
const EXPECTED = "3";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = pathToFileURL(path.join(here, "index.html")).href;

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  ok" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// Set CHROMIUM_PATH if your Chromium is not where Playwright normally puts it.
const executablePath = process.env["CHROMIUM_PATH"];
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});

async function newPage(viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(`Math.random = () => ${FIXED_RANDOM};`);
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(150);
  return { page, context, errors };
}

const score = (page) => page.locator("#score").textContent();

// --- A. the loop runs and a contact is consumed -----------------------------
{
  const { page, context, errors } = await newPage();
  await page.locator("#cta").click();
  await page.waitForTimeout(STEP_MS * 3 + 120);
  const s = await score(page);
  check("A. loop advances and eats the contacts ahead", s === EXPECTED, `score=${s}`);
  check("A. no page errors during play", errors.length === 0, errors.join("; "));
  await context.close();
}

// --- B. steering actually redirects the head --------------------------------
// Same fixed contact at (7,10). Turning up before the first tick means the
// head goes to (6,9) instead, so the score must stay 0. A steering no-op
// would score 1 exactly like test A.
{
  const { page, context, errors } = await newPage();
  await page.locator("#cta").click();
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(STEP_MS * 3 + 120);
  const s = await score(page);
  check("B. steering changes the path (no contact eaten)", s === "0", `score=${s}`);
  check("B. no page errors while steering", errors.length === 0, errors.join("; "));
  await context.close();
}

// --- C. the play canvas is not blank ----------------------------------------
{
  const { page, context } = await newPage();
  await page.locator("#cta").click();
  await page.waitForTimeout(STEP_MS * 4);
  const lit = await page.evaluate(() => {
    const c = document.getElementById("play");
    const g = c.getContext("2d");
    const { data } = g.getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) n += 1;
    return n;
  });
  check("C. play canvas has lit pixels (renders something)", lit > 200, `${lit} px`);
  await context.close();
}

// --- D. collision ends the run and records a best ---------------------------
// From (7,10) heading right with no further input, the wall at x=20 is hit.
{
  const { page, context } = await newPage();
  await page.locator("#cta").click();
  await page.waitForTimeout(STEP_MS * 16 + 400);
  const overlayShown = await page.locator("#overlay").isVisible();
  const subtitle = (await page.locator("#subtitle").textContent()) ?? "";
  const best = await page.locator("#best").textContent();
  check("D. wall collision ends the run", overlayShown && /Signal lost/.test(subtitle),
    `overlay=${overlayShown} subtitle=${JSON.stringify(subtitle)}`);
  check("D. best score is recorded", best === EXPECTED, `best=${best}`);
  await context.close();
}

// --- E. pause resumes instead of restarting ---------------------------------
// The regression this covers: the CTA reads "Resume" while paused, so pressing
// it must keep the score, not reset it to 0.
{
  const { page, context } = await newPage();
  await page.locator("#cta").click();
  await page.waitForTimeout(STEP_MS * 3 + 120);
  const before = await score(page);
  await page.keyboard.press("Space");
  await page.waitForTimeout(100);
  const label = await page.locator("#cta").textContent();
  await page.locator("#cta").click();
  await page.waitForTimeout(80);
  const after = await score(page);
  const hidden = await page.locator("#overlay").isHidden();
  check("E. pause overlay offers Resume", (label ?? "").trim() === "Resume", `cta=${label}`);
  check("E. Resume keeps the run alive", before === EXPECTED && after === EXPECTED && hidden,
    `before=${before} after=${after} resumed=${hidden}`);
  await context.close();
}

// --- F. sound toggle -------------------------------------------------------
{
  const { page, context, errors } = await newPage();
  await page.locator("#sound").click();
  const pressed = await page.locator("#sound").getAttribute("aria-pressed");
  const label = await page.locator("#sound").textContent();
  check("F. sound toggle flips state", pressed === "true" && /on/i.test(label ?? ""),
    `aria-pressed=${pressed} label=${label}`);
  check("F. audio init throws nothing", errors.length === 0, errors.join("; "));
  await context.close();
}

// --- G. no horizontal overflow on a phone viewport --------------------------
{
  const { page, context } = await newPage({ width: 390, height: 844 });
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const canvasFits = await page.evaluate(() => {
    const r = document.getElementById("play").getBoundingClientRect();
    return r.width > 0 && r.width <= window.innerWidth + 1;
  });
  check("G. no horizontal scroll at 390px", overflow <= 0, `overflow=${overflow}px`);
  check("G. play field fits the viewport", canvasFits);
  await context.close();
}

// --- H. self-contained: no external requests --------------------------------
{
  const context = await browser.newContext();
  const page = await context.newPage();
  const external = [];
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith("file://") && !u.startsWith("data:") && !u.startsWith("blob:")) {
      external.push(u);
    }
  });
  await page.goto(target, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);
  check("H. makes zero external requests (CSP-safe)", external.length === 0,
    external.join("; "));
  await context.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

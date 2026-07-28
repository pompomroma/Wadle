# Phosphor

A CRT oscilloscope arcade game in one self-contained HTML file. No build step,
no dependencies, no network requests — open `index.html` in a browser.

It is here as a worked example of the standard the rest of this repository is
built around: **a product ships only when its execution has been verified.**
"It renders without throwing" is not that standard. `verify.mjs` drives a real
browser and asserts the game actually plays.

## Running the checks

```bash
npm install playwright-core
node verify.mjs                    # 14 checks
```

If Chromium is not where Playwright expects it, point at it:

```bash
CHROMIUM_PATH=/path/to/chromium node verify.mjs
```

## What is asserted

Contact placement is randomised, so `Math.random` is pinned before any page
script runs. That turns "did it score?" into an exact expected number:

| Check | Asserts |
|---|---|
| A | The loop advances and the contacts dead ahead are consumed — score reaches the derived value |
| B | Steering redirects the head: the same fixed contact is *not* eaten, so the score stays 0 |
| C | The play canvas has lit pixels — it is not a blank surface |
| D | Running into a wall ends the run and the best score is recorded |
| E | The pause overlay's button resumes the run instead of restarting it |
| F | The sound toggle flips state and audio init throws nothing |
| G | No horizontal scroll at a 390px viewport, and the field fits |
| H | Zero external requests — the file is genuinely self-contained |

Check B is the one that matters most. A game whose steering did nothing would
still pass check A, because the head would drift into the contact anyway. B
fails in that case, so A and B together distinguish a working control scheme
from an inert one.

### Where the expected score comes from

`predict.mjs` re-implements the spawn and step rules independently and prints
the score those rules produce:

```
tick 1 at (7,10) combo ×1 → 1
tick 2 at (8,10) combo ×2 → 3
expected score after 3 ticks: 3
```

The browser test asserts that same 3. Deriving it separately is the point — an
expectation copied from whatever the game printed asserts only that the game is
consistent with itself.

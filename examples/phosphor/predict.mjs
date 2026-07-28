/**
 * Independent re-implementation of the spawn/step rules from phosphor.html,
 * used only to derive the expected score for the browser test. If this and the
 * real game agree, the expected value came from the rules rather than from
 * whatever the game happened to print.
 */
const COLS = 21, ROWS = 21;
const R = 214.5 / 438;
const COMBO_WINDOW = 2600, STEP_MS = 148;

let snake = [
  { x: 6, y: 10 }, { x: 5, y: 10 }, { x: 4, y: 10 },
];
const dir = { x: 1, y: 0 };

function spawn() {
  const taken = new Set(snake.map((s) => s.x + "," + s.y));
  const open = [];
  for (let y = 0; y < ROWS; y += 1)
    for (let x = 0; x < COLS; x += 1)
      if (!taken.has(x + "," + y)) open.push({ x, y });
  return open[(R * open.length) | 0];
}

let contact = spawn();
let score = 0, combo = 0, lastAt = -Infinity;
const eaten = [];

for (let tick = 1; tick <= 3; tick += 1) {
  const now = tick * STEP_MS;
  const head = snake[0];
  const next = { x: head.x + dir.x, y: head.y + dir.y };
  snake.unshift(next);
  if (contact && next.x === contact.x && next.y === contact.y) {
    combo = now - lastAt < COMBO_WINDOW ? Math.min(combo + 1, 5) : 1;
    lastAt = now;
    score += 1 * combo;
    eaten.push(`tick ${tick} at (${contact.x},${contact.y}) combo ×${combo} → ${score}`);
    contact = spawn();
  } else {
    snake.pop();
  }
}

console.log(eaten.join("\n"));
console.log("expected score after 3 ticks:", score);

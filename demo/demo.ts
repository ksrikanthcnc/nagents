/**
 * nagents demo — standalone web page showcasing the overlay.
 *
 * No Tauri/Rust needed. Simulates sessions with mock data.
 * Controls panel lets you add/remove sessions and change states.
 * Overlay renders chars with full physics (imported from ../ui/overlay/).
 *
 * For GitHub Pages: build with Vite, deploy demo/ as static site.
 */

// TODO: Import overlay physics + modes from shared modules
// For now, scaffold with mock rendering

interface DemoSession {
  id: string;
  name: string;
  group: string;
  source: string;
  event: string;
  attention: boolean;
  priority: string | null;
  character: string;
}

const sessions: DemoSession[] = [];
let nextId = 1;

const CHARS = ["ghost", "cat", "skeleton", "robot", "owl", "mushroom", "flame", "crystal", "cloud", "blob"];

function randomChar(): string {
  return CHARS[Math.floor(Math.random() * CHARS.length)];
}

function addSession(source: string, name: string, event: string): DemoSession {
  const group = name.includes(":") ? name.split(":")[0] : source;
  const title = name.includes(":") ? name.split(":").slice(1).join(":") : name;
  const session: DemoSession = {
    id: `demo-${nextId++}`,
    name: title,
    group,
    source,
    event,
    attention: event !== "running",
    priority: event === "idle" ? "low" : null,
    character: randomChar(),
  };
  sessions.push(session);
  updateStatus();
  return session;
}

function clearAll(): void {
  sessions.length = 0;
  updateStatus();
}

function updateStatus(): void {
  const bar = document.getElementById("status-bar");
  if (bar) {
    const follow = sessions.filter(s => s.attention && (s.event === "idle" || s.event === "approval" || s.event === "stuck")).length;
    const working = sessions.filter(s => s.event === "running" || s.event === "tool").length;
    bar.textContent = `Sessions: ${sessions.length} | Follow: ${follow} | Working: ${working}`;
  }
}

function randomSessions(count: number): void {
  const events = ["running", "idle", "approval", "stuck", "tool"];
  const groups = ["PPTP", "infra", "data", "frontend", "ops"];
  for (let i = 0; i < count; i++) {
    const group = groups[Math.floor(Math.random() * groups.length)];
    const event = events[Math.floor(Math.random() * events.length)];
    addSession("cli", `${group}:task-${nextId}`, event);
  }
}

async function autoLifecycle(): Promise<void> {
  clearAll();
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

  addSession("ide", "haive:app", "running");
  addSession("cli", "PPTP:fix-bug", "running");
  addSession("crew", "ops:deploy", "running");
  await wait(2000);

  sessions[0].event = "idle"; sessions[0].attention = true;
  updateStatus();
  await wait(2000);

  sessions[1].event = "approval"; sessions[1].attention = true;
  updateStatus();
  await wait(2000);

  addSession("ide", "data:analysis", "idle");
  addSession("cli", "infra:scale", "stuck");
  updateStatus();
  await wait(3000);

  sessions[2].event = "idle"; sessions[2].attention = true;
  updateStatus();
}

// ─── Wire up controls ───────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  const btnAdd = document.getElementById("btn-add");
  const btnRandom = document.getElementById("btn-random");
  const btnLifecycle = document.getElementById("btn-lifecycle");
  const btnClear = document.getElementById("btn-clear");
  const sourceEl = document.getElementById("source") as HTMLSelectElement;
  const nameEl = document.getElementById("name") as HTMLInputElement;

  btnAdd?.addEventListener("click", () => {
    const source = sourceEl.value;
    const name = nameEl.value || `session-${nextId}`;
    // Get selected state
    const stateBtn = document.querySelector(".btn-group button.active");
    const event = stateBtn?.getAttribute("data-state") || "running";
    addSession(source, name, event);
    nameEl.value = "";
  });

  btnRandom?.addEventListener("click", () => randomSessions(5));
  btnLifecycle?.addEventListener("click", () => autoLifecycle());
  btnClear?.addEventListener("click", () => clearAll());

  // State buttons toggle
  document.querySelectorAll(".btn-group button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".btn-group button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  updateStatus();
});

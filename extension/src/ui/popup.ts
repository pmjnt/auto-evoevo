import { send } from "./shared.js";

function show(id: "locked" | "unlocked"): void {
  document.getElementById("locked")?.classList.toggle("active", id === "locked");
  document.getElementById("unlocked")?.classList.toggle("active", id === "unlocked");
}

async function refresh(): Promise<void> {
  const status = (await send({ type: "get-status" })) as {
    ok: boolean;
    locked: boolean;
    address: string | null;
    counts: Record<string, number>;
  };
  if (!status.ok) return;
  if (status.locked) {
    show("locked");
    return;
  }
  show("unlocked");
  setText("address", status.address ?? "—");
  setText("signed", String(status.counts["signed"] ?? 0));
  setText("dry", String(status.counts["dry_run"] ?? 0));
  setText("manual", String(status.counts["manual_review"] ?? 0));
  setText("rejected", String(status.counts["rejected"] ?? 0));
}

function setText(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

document.getElementById("unlock")?.addEventListener("click", async () => {
  const password = (document.getElementById("password") as HTMLInputElement).value;
  const response = (await send({ type: "unlock", password })) as {
    ok: boolean;
    error?: { message: string };
  };
  if (!response.ok) {
    setText("unlock-error", response.error?.message ?? "Failed to unlock");
    return;
  }
  await refresh();
});

document.getElementById("lock")?.addEventListener("click", async () => {
  await send({ type: "lock" });
  await refresh();
});

document.getElementById("pause")?.addEventListener("click", async () => {
  await send({ type: "pause" });
});

void refresh();

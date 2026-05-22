import { send } from "./shared.js";

function value(id: string): string {
  return (document.getElementById(id) as HTMLInputElement).value.trim();
}

function setMsg(text: string, color = "#9ece6a"): void {
  const el = document.getElementById("msg");
  if (el) {
    el.textContent = text;
    el.style.color = color;
  }
}

document.getElementById("save")?.addEventListener("click", async () => {
  const config = {
    allowedOrigin: "https://evoevo.ai",
    allowedChain: "0G",
    chainId: Number(value("chainId")),
    rpcUrl: value("rpcUrl"),
    allowedContracts: value("allowedContracts").split(",").map((s) => s.trim()).filter(Boolean),
    allowedFunctionSelectors: value("allowedFunctionSelectors").split(",").map((s) => s.trim()).filter(Boolean),
    maxFeeNative: Number(value("maxFeeNative")),
    dryRun: true,
    idleLockMinutes: Number(value("idleLockMinutes")) || 30,
  };

  const setConfig = await send({ type: "set-config", config });
  if (!setConfig.ok) {
    setMsg("Failed to save config", "#f7768e");
    return;
  }

  const privateKey = value("privateKey");
  const password = value("password");
  if (privateKey && password) {
    const importResult = await send({ type: "import-key", privateKey, password });
    if (!importResult.ok) {
      setMsg("Config saved but key import failed", "#f7768e");
      return;
    }
    (document.getElementById("privateKey") as HTMLInputElement).value = "";
    (document.getElementById("password") as HTMLInputElement).value = "";
  }

  setMsg("Saved");
});

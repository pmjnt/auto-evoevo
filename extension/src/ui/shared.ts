export async function send(message: unknown): Promise<{ ok: boolean; [k: string]: unknown }> {
  return await new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response as { ok: boolean }));
  });
}

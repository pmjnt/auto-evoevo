type SendResponse = {
  ok: boolean;
  error?: { code: number; message: string };
  [k: string]: unknown;
};

export async function send(message: unknown): Promise<SendResponse> {
  return await new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        resolve({
          ok: false,
          error: { code: -32603, message: lastError.message ?? String(lastError) },
        });
        return;
      }
      if (response === undefined || response === null) {
        resolve({
          ok: false,
          error: { code: -32603, message: "No response from background" },
        });
        return;
      }
      resolve(response as SendResponse);
    });
  });
}

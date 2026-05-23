type Listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;

class FakeStorageArea {
  private store: Record<string, unknown> = {};
  private listeners: Listener[] = [];

  constructor(private readonly areaName: string) {}

  get = async (
    keys: string | string[] | Record<string, unknown> | null,
  ): Promise<Record<string, unknown>> => {
    if (keys === null || keys === undefined) {
      return { ...this.store };
    }
    if (typeof keys === "string") {
      return { [keys]: this.store[keys] };
    }
    if (Array.isArray(keys)) {
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        out[key] = this.store[key];
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(keys)) {
      out[key] = this.store[key] ?? (keys as Record<string, unknown>)[key];
    }
    return out;
  };

  set = async (items: Record<string, unknown>): Promise<void> => {
    const changes: Record<string, chrome.storage.StorageChange> = {};
    for (const [key, value] of Object.entries(items)) {
      changes[key] = { oldValue: this.store[key], newValue: value };
      this.store[key] = value;
    }
    for (const listener of this.listeners) listener(changes, this.areaName);
  };

  remove = async (keys: string | string[]): Promise<void> => {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) delete this.store[key];
  };

  clear = async (): Promise<void> => {
    this.store = {};
  };

  onChanged = {
    addListener: (listener: Listener) => this.listeners.push(listener),
    removeListener: (listener: Listener) => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    },
  };

  _peek(): Record<string, unknown> {
    return { ...this.store };
  }
}

class FakeTabsApi {
  private tabs: chrome.tabs.Tab[] = [];
  private messages: Array<{ tabId: number; message: unknown }> = [];
  private nextId = 1;
  private removedListeners: Array<(tabId: number) => void> = [];

  query = async (queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> => {
    const urlPattern = typeof queryInfo.url === "string" ? queryInfo.url : null;
    if (urlPattern === "https://evoevo.ai/*") {
      return this.tabs.filter((tab) => tab.url?.startsWith("https://evoevo.ai/"));
    }
    return [...this.tabs];
  };

  create = async (createProperties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> => {
    const tab: chrome.tabs.Tab = {
      id: this.nextId,
      index: this.tabs.length,
      highlighted: false,
      active: createProperties.active ?? false,
      pinned: false,
      incognito: false,
      selected: false,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
      windowId: 1,
      url: createProperties.url,
    };
    this.nextId += 1;
    this.tabs.push(tab);
    return tab;
  };

  sendMessage = async (tabId: number, message: unknown): Promise<void> => {
    this.messages.push({ tabId, message });
  };

  onRemoved = {
    addListener: (listener: (tabId: number) => void) => {
      this.removedListeners.push(listener);
    },
    removeListener: (listener: (tabId: number) => void) => {
      this.removedListeners = this.removedListeners.filter((item) => item !== listener);
    },
  };

  _add(tab: Partial<chrome.tabs.Tab> & { id: number; url: string }): void {
    this.tabs.push({
      index: this.tabs.length,
      highlighted: false,
      active: false,
      pinned: false,
      incognito: false,
      selected: false,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
      windowId: 1,
      ...tab,
    });
    this.nextId = Math.max(this.nextId, tab.id + 1);
  }

  _messages(): Array<{ tabId: number; message: unknown }> {
    return [...this.messages];
  }

  _tabs(): chrome.tabs.Tab[] {
    return [...this.tabs];
  }

  _remove(tabId: number): void {
    this.tabs = this.tabs.filter((tab) => tab.id !== tabId);
    for (const listener of this.removedListeners) listener(tabId);
  }
}

export function installFakeChromeApi(): {
  local: FakeStorageArea;
  session: FakeStorageArea;
  tabs: FakeTabsApi;
  reset: () => void;
} {
  const local = new FakeStorageArea("local");
  const session = new FakeStorageArea("session");
  const tabs = new FakeTabsApi();

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local, session },
    runtime: {
      lastError: undefined,
      sendMessage: async () => undefined,
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
    },
    action: {
      setBadgeText: async () => undefined,
      setBadgeBackgroundColor: async () => undefined,
      openPopup: async () => undefined,
    },
    tabs,
  };

  return {
    local,
    session,
    tabs,
    reset: () => {
      local.clear();
      session.clear();
    },
  };
}

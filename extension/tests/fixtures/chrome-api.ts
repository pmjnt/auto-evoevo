type Listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
type AlarmListener = (alarm: chrome.alarms.Alarm) => void;

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

class FakeAlarms {
  private alarms = new Map<string, chrome.alarms.Alarm>();
  private listeners: AlarmListener[] = [];

  create = async (name: string, info: chrome.alarms.AlarmCreateInfo): Promise<void> => {
    const scheduledTime = info.when ?? Date.now() + (info.delayInMinutes ?? 0) * 60_000;
    this.alarms.set(name, { name, scheduledTime });
  };

  clear = async (name: string): Promise<boolean> => this.alarms.delete(name);

  get = async (name: string): Promise<chrome.alarms.Alarm | undefined> => this.alarms.get(name);

  onAlarm = {
    addListener: (listener: AlarmListener) => this.listeners.push(listener),
    removeListener: (listener: AlarmListener) => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    },
  };

  _fire(name: string): void {
    const alarm = this.alarms.get(name) ?? { name, scheduledTime: Date.now() };
    this.alarms.delete(name);
    for (const listener of this.listeners) listener(alarm);
  }
}

export function installFakeChromeApi(): {
  local: FakeStorageArea;
  session: FakeStorageArea;
  alarms: FakeAlarms;
  reset: () => void;
} {
  const local = new FakeStorageArea("local");
  const session = new FakeStorageArea("session");
  const alarms = new FakeAlarms();

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { local, session },
    alarms: { ...alarms, onAlarm: alarms.onAlarm },
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
  };

  return {
    local,
    session,
    alarms,
    reset: () => {
      local.clear();
      session.clear();
    },
  };
}

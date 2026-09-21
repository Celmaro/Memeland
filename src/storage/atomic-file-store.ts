import fs from 'fs';
import path from 'path';

export function atomicWriteJsonSync(filePath: string, data: unknown): void {
  const absolutePath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tempPath, absolutePath);
}

export function readJsonFileSafe<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch (error) {
    console.warn(`[ATOMIC STORE] Failed to read ${filePath}, using fallback: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}

export interface AtomicFileStoreOptions {
  debounceMs?: number;
}

/** JSON snapshot store with atomic temp+rename writes and optional debouncing. */
export class AtomicFileStore<T> {
  private readonly filePath: string;
  private readonly debounceMs: number;
  private value: T;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath: string, fallback: T, options: AtomicFileStoreOptions = {}) {
    this.filePath = filePath;
    this.debounceMs = options.debounceMs ?? 0;
    this.value = readJsonFileSafe(filePath, fallback);
  }

  get(): T {
    return this.value;
  }

  set(next: T): void {
    this.value = next;
    this.scheduleWrite();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    atomicWriteJsonSync(this.filePath, this.value);
  }

  private scheduleWrite(): void {
    if (this.debounceMs > 0) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.debounceMs);
      return;
    }
    this.flush();
  }
}

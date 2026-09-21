export interface GracefulShutdownHooks {
  flush: () => void;
  stop: () => void | Promise<void>;
}

/** Registers a one-shot graceful shutdown handler that flushes and stops cleanly. */
export function registerGracefulShutdown(signal: string, hooks: GracefulShutdownHooks): void {
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[SHUTDOWN] Received ${signal}. Flushing state to disk...`);
    try {
      hooks.flush();
      await hooks.stop();
    } catch (err: any) {
      console.error(`[SHUTDOWN] Failed while stopping: ${err?.message ?? err}`);
    }
    console.log('[SHUTDOWN] State saved. Goodbye!');
    process.exit(0);
  };
  process.on(signal, () => void shutdown());
}

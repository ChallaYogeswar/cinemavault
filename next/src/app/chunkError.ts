/** A part of the app that is loaded on demand could not be fetched (offline, or a newer release). */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /dynamically imported module|importing a module script|module script failed|loading chunk|chunkloaderror/i.test(
    message,
  );
}

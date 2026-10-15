type AbortableSleepStream = {
  aborted?: boolean;
  onAbort: (listener: () => void | Promise<void>) => void;
  sleep: (ms: number) => Promise<unknown>;
};

export async function waitForSseAbort(stream: AbortableSleepStream, intervalMs = 1000): Promise<void> {
  let aborted = stream.aborted === true;

  stream.onAbort(() => {
    aborted = true;
  });

  while (!aborted) {
    await stream.sleep(intervalMs);
  }
}

/** Serve estimate requests on `port`; done automatically when this module starts a dedicated worker. */
export function attachEstimateWorker(port: { postMessage(message: unknown): void; addEventListener(type: "message", listener: (event: MessageEvent) => void): void }): void;

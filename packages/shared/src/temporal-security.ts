export interface TemporalTlsConfig {
  serverRootCACertificate?: Uint8Array;
  serverNameOverride?: string;
  clientCertPair?: {
    crt: Uint8Array;
    key: Uint8Array;
  };
}

function readEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

type NodeFsModule = {
  existsSync(path: string): boolean;
  readFileSync(path: string): Uint8Array;
};

function getNodeFs(): NodeFsModule | undefined {
  const nodeProcess = globalThis.process as
    | (NodeJS.Process & { getBuiltinModule?: (id: string) => unknown })
    | undefined;
  const fsModule = nodeProcess?.getBuiltinModule?.("node:fs");
  if (!fsModule) {
    return undefined;
  }

  return fsModule as NodeFsModule;
}

function isContainerRuntime(): boolean {
  return getNodeFs()?.existsSync("/.dockerenv") ?? false;
}

function rewriteDockerHostname(rawAddress: string | undefined): string | undefined {
  if (!rawAddress || isContainerRuntime()) {
    return rawAddress;
  }

  const [host, ...rest] = rawAddress.split(":");
  if (host !== "temporal") {
    return rawAddress;
  }

  return ["localhost", ...rest].join(":");
}

function readSecretValue(
  pemValue: string | undefined,
  pathValue: string | undefined
): Uint8Array | undefined {
  const inline = readEnv(pemValue);
  if (inline) {
    return new TextEncoder().encode(inline.replace(/\\n/g, "\n"));
  }

  const resolvedPath = readEnv(pathValue);
  const fsModule = getNodeFs();
  if (!resolvedPath || !fsModule?.existsSync(resolvedPath)) {
    return undefined;
  }

  return fsModule.readFileSync(resolvedPath);
}

export interface TemporalSecurityConfig {
  address: string;
  namespace: string;
  taskQueue: string;
  tls?: TemporalTlsConfig;
}

export function createTemporalSecurityConfig(
  env: NodeJS.ProcessEnv
): TemporalSecurityConfig {
  const address = rewriteDockerHostname(readEnv(env.TEMPORAL_ADDRESS)) ?? "localhost:7233";
  const namespace = readEnv(env.TEMPORAL_NAMESPACE) ?? "default";
  const taskQueue = readEnv(env.TEMPORAL_TASK_QUEUE) ?? "docslurp-pipeline";
  const tlsEnabled = env.TEMPORAL_TLS_ENABLED === "true";

  if (env.NODE_ENV === "production" && namespace === "default") {
    throw new Error("TEMPORAL_NAMESPACE must be set to a non-default namespace in production");
  }

  const serverRootCACertificate = readSecretValue(
    env.TEMPORAL_TLS_CA_CERT_PEM,
    env.TEMPORAL_TLS_CA_CERT_PATH
  );
  const clientCert = readSecretValue(
    env.TEMPORAL_TLS_CLIENT_CERT_PEM,
    env.TEMPORAL_TLS_CLIENT_CERT_PATH
  );
  const clientKey = readSecretValue(
    env.TEMPORAL_TLS_CLIENT_KEY_PEM,
    env.TEMPORAL_TLS_CLIENT_KEY_PATH
  );
  const serverNameOverride = readEnv(env.TEMPORAL_TLS_SERVER_NAME);

  const tls =
    tlsEnabled || serverRootCACertificate || clientCert || clientKey || serverNameOverride
      ? {
          serverRootCACertificate,
          serverNameOverride,
          clientCertPair:
            clientCert && clientKey
              ? {
                  crt: clientCert,
                  key: clientKey
                }
              : undefined
        }
      : undefined;

  return {
    address,
    namespace,
    taskQueue,
    tls
  };
}

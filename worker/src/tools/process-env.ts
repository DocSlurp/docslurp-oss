export const defaultParserEnvAllowlist = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "OPENSSL_CONF",
  "PYTHON_VENV",
  "TMP",
  "TMPDIR",
  "TEMP",
  "TZ"
] as const;

export const vectorBackendEnvAllowlist = [
  "LANCEDB_URI",
  "STORAGE_URI",
  "CHROMA_PATH",
  "CHROMA_URL",
  "MILVUS_URI",
  "ORAMA_PATH",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN"
] as const;

export const defaultPythonPoolEnvAllowlist = [
  ...defaultParserEnvAllowlist,
  "DOCSLURP_EMBED_TEXT_STUB",
  "HF_HOME",
  "HOME",
  "MKL_NUM_THREADS",
  "OMP_NUM_THREADS",
  "TOKENIZERS_PARALLELISM",
  "TRANSFORMERS_CACHE",
  "UV_NO_CACHE"
] as const;

export function buildAllowlistedEnv(args: {
  allowlistEnvVar?: string;
  defaultAllowlist: readonly string[];
  overrides?: Record<string, string | undefined>;
  sourceEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const sourceEnv = args.sourceEnv ?? process.env;
  const allowlist = new Set<string>(args.defaultAllowlist);
  const rawExtraAllowlist = args.allowlistEnvVar ? sourceEnv[args.allowlistEnvVar] : undefined;

  for (const entry of (rawExtraAllowlist ?? "").split(",")) {
    const key = entry.trim();
    if (key) {
      allowlist.add(key);
    }
  }

  const env: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    const value = sourceEnv[key];
    if (value !== undefined && value !== "") {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(args.overrides ?? {})) {
    if (value === undefined || value === "") {
      delete env[key];
      continue;
    }
    env[key] = value;
  }

  return env;
}

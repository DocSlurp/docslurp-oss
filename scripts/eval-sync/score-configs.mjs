// Scorer registry -> Langfuse score configs (POST /api/public/score-configs).
// A config name is `<prefix>.<component>` where the prefix carries the scorer version. Existing configs are never
// patched: any semantic difference is a conflict that requires a new scorer version (a new prefix).
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { hash, stableJson } from "./langfuse.mjs";

const NAME = /^[A-Za-z0-9_ .()-]{1,35}$/;
const TYPES = new Set(["NUMERIC", "BOOLEAN", "CATEGORICAL"]);

/** Verify the pinned source by hashing `git show <commit>:<path>` when a checkout is available. */
export function verifyCode(code, { exec = execFileSync } = {}) {
  if (!code?.repo || !code.path || !/^[0-9a-f]{7,40}$/.test(code.commit ?? "")) return { status: "pending", reason: "no committed code reference" };
  if (!code.checkout) return { status: code.sourceSha256 ? "pinned-unverified" : "pending", reason: code.sourceSha256 ? "no local checkout configured" : "no sourceSha256" };
  let source;
  try { source = exec("git", ["-C", code.checkout, "show", `${code.commit}:${code.path}`], { maxBuffer: 64 * 1024 * 1024 }); }
  catch { return { status: "error", reason: `cannot read ${code.path}@${code.commit} from checkout` }; }
  const sha = hash(source);
  if (code.sourceSha256 && code.sourceSha256 !== sha) return { status: "error", reason: `source hash mismatch for ${code.path}@${code.commit}` };
  return { status: "verified", sourceSha256: sha };
}

export function describe(scorer, component, sourceSha256) {
  const learned = scorer.learned ? ` model=${scorer.learned.model} prompt=${scorer.learned.promptVersion} settings=${stableJson(scorer.learned.settings ?? {})}` : "";
  return [
    component.description,
    `Scorer: ${scorer.description}`,
    `[docslurp-scorer id=${scorer.id} version=${scorer.version} component=${component.name} kind=${scorer.kind ?? "deterministic"} direction=${component.direction ?? "higher-better"} code=${scorer.code.repo}:${scorer.code.path}@${scorer.code.commit} sha256=${sourceSha256}${learned}]`,
  ].join("\n");
}

/** Build desired configs. Returns `{ configs, skipped }`; throws on malformed registry entries. */
export function desiredScoreConfigs(registry, { verify = verifyCode } = {}) {
  const configs = [], skipped = [];
  for (const scorer of registry.scorers ?? []) {
    if (!scorer.id || !scorer.version || !scorer.prefix || !scorer.description) throw new Error("Scorer needs id, version, prefix and description");
    if (scorer.kind === "learned" && (!scorer.learned?.model || !scorer.learned?.promptVersion)) throw new Error(`Learned scorer ${scorer.id} must record model and promptVersion`);
    const code = verify(scorer.code ?? {});
    if (code.status === "pending" || scorer.status === "pending") { skipped.push({ scorer: `${scorer.id}@${scorer.version}`, reason: scorer.pendingReason ?? code.reason ?? "pending" }); continue; }
    if (code.status === "error") throw new Error(`Scorer ${scorer.id}@${scorer.version}: ${code.reason}`);
    const sourceSha256 = code.sourceSha256 ?? scorer.code.sourceSha256;
    for (const component of scorer.components ?? []) {
      const name = `${scorer.prefix}.${component.name}`;
      if (!NAME.test(name)) throw new Error(`Score config name ${JSON.stringify(name)} must be at most 35 letters, digits, spaces, _ . ( ) -`);
      if (!TYPES.has(component.dataType)) throw new Error(`${name}: unsupported dataType ${component.dataType}`);
      if (!component.description) throw new Error(`${name}: description required`);
      const body = { name, dataType: component.dataType, description: describe(scorer, component, sourceSha256) };
      if (component.dataType === "NUMERIC") { body.minValue = component.min ?? null; body.maxValue = component.max ?? null; }
      if (component.dataType === "CATEGORICAL") body.categories = component.categories;
      configs.push({ body, scorer: `${scorer.id}@${scorer.version}`, codeStatus: code.status });
    }
  }
  const names = configs.map((config) => config.body.name);
  if (new Set(names).size !== names.length) throw new Error("Two registry components produce the same score config name");
  return { configs, skipped };
}

const semantic = (config) => stableJson({ dataType: config.dataType, minValue: config.dataType === "NUMERIC" ? config.minValue ?? null : null, maxValue: config.dataType === "NUMERIC" ? config.maxValue ?? null : null, categories: config.dataType === "CATEGORICAL" ? (config.categories ?? []).map(({ label, value }) => ({ label, value })) : null, description: config.description ?? null });

export async function listScoreConfigs(api) {
  const all = [];
  let page = 1, totalPages = 1;
  do {
    const listed = await api(`/score-configs?page=${page}&limit=100`);
    if (!listed || !Array.isArray(listed.data)) throw new Error("Score config list failed");
    all.push(...listed.data);
    totalPages = listed.meta?.totalPages ?? 1;
    page++;
  } while (page <= totalPages && page < 1000);
  return all;
}

export async function syncScoreConfigs(api, configs) {
  const remote = new Map();
  for (const config of await listScoreConfigs(api)) {
    if (remote.has(config.name)) throw new Error(`Remote has duplicate score config name ${config.name}`);
    remote.set(config.name, config);
  }
  const result = { created: 0, unchanged: 0, conflicts: [], ids: {} };
  for (const { body } of configs) {
    const existing = remote.get(body.name);
    if (existing) {
      if (existing.isArchived || semantic(existing) !== semantic(body)) { result.conflicts.push(body.name); continue; }
      result.unchanged++; result.ids[body.name] = existing.id; continue;
    }
    const created = await api("/score-configs", body);
    const readback = created?.id ? await api(`/score-configs/${created.id}`) : null;
    if (!readback || semantic(readback) !== semantic(body)) throw new Error(`Score config readback mismatch for ${body.name}`);
    result.created++; result.ids[body.name] = readback.id;
  }
  if (result.conflicts.length) throw Object.assign(new Error(`Score configs differ from the registry (bump the scorer version, never mutate): ${result.conflicts.join(", ")}`), { partial: result });
  return result;
}

export const loadRegistry = async (path) => JSON.parse(await readFile(path, "utf8"));

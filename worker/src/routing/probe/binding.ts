/**
 * Raw access to the in-process native-pdf binding for the page probe.
 *
 * The probe needs members the engine-neutral `NativePdfEngine` adapter does not carry (widgets, annotations, fonts,
 * optional content, JavaScript, attachments), so it reads the binding module directly. Discovery, env mapping and
 * caching are shared with the adapter (`../../native-pdf/loader.ts`). The shape is structural so the probe compiles
 * and tests run without the private package installed.
 */
import { loadNativePdfModule } from "../../native-pdf/loader.js";

export type Box = [number, number, number, number];

export interface ProbeBindingPage {
  size(): { widthPt: number; heightPt: number; rotation: number };
  spans(): Array<{ text: string; bbox: Box; font: string; size: number; renderMode: number; invisible: boolean; unmapped: number }>;
  /** Word boxes (newer bindings). Unlike `spans()` they never merge text across side-by-side columns. */
  words?(): Array<{ text: string; bbox: Box }>;
  glyphStats(): { glyphs: number; invisible: number; stroke: number; unmapped: number; fonts: number };
  images(): Array<{ index: number; bbox: Box; widthPx: number; heightPx: number; effectiveDpi: number }>;
  drawings(): { lineCount: number; rectCount: number; longRuleCount: number; pathCount?: number; vectorArea: number; hRuleCount?: number; vRuleCount?: number };
  tables?(options?: { strategy?: "lines" | "text" }): Array<{ bbox: Box; rows: string[][]; rowCount: number; colCount: number; confidence: number }>;
  widgets(): Array<{ kind: string; name?: string; value?: string; bbox: Box }>;
  annotations(): Array<{ subtype: string; contents?: string; uri?: string; bbox: Box }>;
  links(): Array<{ uri?: string; kind: string; destPage?: number; bbox: Box }>;
  renderAsync(options?: { dpi?: number; maxEdgePx?: number; clip?: Box; format?: "png" | "jpeg" | "webp"; gray?: boolean; quality?: number }): Promise<Buffer>;
}

export interface ProbeBindingDoc {
  pageCount(): number;
  metadata(): { producer?: string; creator?: string; encrypted: boolean };
  hasJavaScript(): boolean;
  optionalContent(): Array<{ name: string; visible: boolean }>;
  attachments(): Array<{ name: string; size: number }>;
  fonts(page?: number): Array<{ name: string; type: string; embedded: boolean; hasToUnicode: boolean; isType3: boolean }>;
  page(i: number): ProbeBindingPage;
  close(): void;
}

export interface ProbeBinding {
  version(): { version: string; gitSha: string; features: string[] };
  openPath(path: string, options?: { password?: string; limits?: { profile?: "web" | "worker" } & Record<string, number | string | undefined> }): ProbeBindingDoc;
}

export type ProbeBindingLoad = { ok: true; binding: ProbeBinding; source: string } | { ok: false; reason: string };

function isProbeBinding(value: unknown): value is ProbeBinding {
  const v = value as Partial<ProbeBinding> | null;
  return typeof v?.version === "function" && typeof v?.openPath === "function";
}

let override: ProbeBindingLoad | null = null;

/** The raw binding, loaded once per process with the adapter's discovery; absence is a normal, reported state. */
export function loadProbeBinding(env: NodeJS.ProcessEnv = process.env): ProbeBindingLoad {
  if (override) return override;
  const loaded = loadNativePdfModule(env);
  if (!loaded.ok) return loaded;
  return isProbeBinding(loaded.module)
    ? { ok: true, binding: loaded.module, source: loaded.source }
    : { ok: false, reason: `${loaded.source}: not a native-pdf binding` };
}

/** Tests inject a binding (or a string to simulate absence); `null` restores discovery. */
export function setProbeBindingForTesting(binding: ProbeBinding | string | null): void {
  override = binding === null ? null : typeof binding === "string" ? { ok: false, reason: binding } : { ok: true, binding, source: "test" };
}

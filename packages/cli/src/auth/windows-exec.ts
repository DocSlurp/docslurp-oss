import { existsSync } from "node:fs";

/**
 * Windows process creation does not search PATHEXT, and `.cmd`/`.bat` files
 * (npm, npx, pnpm shims) only run through cmd.exe. `docslurp exec` resolves the
 * command itself and, for batch files only, builds a cmd.exe command line with
 * every argument quoted and its metacharacters caret-escaped, so arguments are
 * never interpreted by the shell. Everything else runs directly, without a shell.
 */

export type WindowsSpawn = { file: string; args: string[]; verbatim: boolean };

const META = /([()\][%!^"`<>&|;, *?])/g;

/** Quote one argument for CommandLineToArgvW, then caret-escape cmd.exe metacharacters (twice for batch shims). */
export function escapeCmdArgument(arg: string): string {
  let value = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  value = `"${value}"`;
  // cmd.exe parses the line once, and a batch file re-parses %* once more.
  return value.replace(META, "^$1").replace(META, "^$1");
}

function escapeCmdCommand(file: string): string {
  return file.replace(META, "^$1");
}

/** First PATH entry holding `command` with a PATHEXT extension (or as given when it already has one). */
export function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): string | null {
  const extensions = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => ext.toLowerCase());
  // Only a known PATHEXT extension counts: `python3.11` still gets .exe/.cmd appended.
  const hasExtension = extensions.some((ext) => command.toLowerCase().endsWith(ext));
  const candidates = (base: string) => hasExtension ? [base] : extensions.map((ext) => `${base}${ext}`);
  if (/[\\/]/.test(command) || /^[A-Za-z]:/.test(command)) {
    return candidates(command).find(exists) ?? null;
  }
  // Like cmd.exe's lookup, but never the current directory: a planted npm.cmd in a cloned repo must not run.
  // Relative PATH entries (".", "bin") resolve against the working directory: skip them.
  for (const dir of (env.PATH ?? env.Path ?? "").split(";").filter((entry) => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(entry))) {
    const base = `${dir.replace(/[\\/]+$/, "")}\\${command}`;
    const found = candidates(base).find(exists);
    if (found) return found;
  }
  return null;
}

export function windowsSpawn(command: string, args: string[], env: NodeJS.ProcessEnv, exists?: (path: string) => boolean): WindowsSpawn {
  const file = resolveWindowsCommand(command, env, exists);
  if (!file) throw new Error(`Could not find ${command} on PATH.`);
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args, verbatim: false };
  const comspec = env.ComSpec || env.COMSPEC || `${env.SystemRoot || "C:\\Windows"}\\System32\\cmd.exe`;
  const line = [escapeCmdCommand(file), ...args.map(escapeCmdArgument)].join(" ");
  return { file: comspec, args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

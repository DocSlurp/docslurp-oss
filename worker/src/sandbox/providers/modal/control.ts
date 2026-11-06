/**
 * Shell scripts that let the worker kill one remote command. The Modal SDK cannot kill a
 * single exec, so each command records its pid in a per-command control file and a second
 * exec kills its process group. Every script uses only POSIX sh builtins and absolute paths,
 * so they work in any image with /bin/sh and need no PATH.
 */

/** Remote directory holding each command's pid and cancel files; outside every writable path. */
export const CONTROL_DIR = "/tmp/.docslurp-modal-control";

/**
 * Starts the command in the background, in its own session when the image has setsid, so one
 * kill reaches every process it spawns. A background child of a non-interactive shell is
 * never a process group leader, so setsid needs no fork and the command keeps the pid `$!`.
 * Waiting here (rather than `setsid -w`) gives the shell's exit status for the command:
 * 128+N for a death by signal N, as for local commands, with nothing extra on stderr.
 * The background command's stdin is /dev/null.
 */
const LAUNCH_SCRIPT = [
  "start=$1; control=$2; shift 2",
  "launcher=",
  'for s in /usr/bin/setsid /bin/setsid; do [ -x "$s" ] && { launcher=$s; break; }; done',
  '$launcher /bin/sh -c "$start" sh "$control" "$@" &',
  // dash reports a job's death by signal ("Killed") on the waiting shell's stderr; the
  // command's own stderr is already its own descriptor, so silencing wait loses nothing.
  "wait $! 2>/dev/null",
].join("\n");

/** The unprivileged user parser commands run as in the VM (the worker images' `docslurp`, uid and gid 10001). */
export const PARSER_VM_UID = 10001;

/** The tools the root path calls, by absolute path: never from PATH, which the command's env sets (council K #4). */
export interface ParserVmTools { id: string; setpriv: string }
export const PARSER_VM_TOOLS: ParserVmTools = { id: "/usr/bin/id", setpriv: "/usr/bin/setpriv" };

/** argv prefix that runs a command as PARSER_VM_UID (no new privileges, no supplementary groups). */
export function asParserUser(tools: ParserVmTools = PARSER_VM_TOOLS): string[] {
  return [tools.setpriv, `--reuid=${PARSER_VM_UID}`, `--regid=${PARSER_VM_UID}`, "--clear-groups", "--no-new-privs", "--"];
}

/**
 * Records the command's pid, then becomes the command. Checking the cancel file after
 * writing the pid closes the race with a kill that lands before the command starts: either
 * the kill reads the pid, or this sees the cancel file.
 *
 * Modal ignores the image's `USER`, so the VM starts commands as root (validation N10). As root this hands each of the
 * command's writable directories (the directory itself: never recursive, never through a link) to PARSER_VM_UID and
 * drops to it with setpriv before exec. It refuses (exit 126) when the uid cannot be read or setpriv is missing, never
 * running as root. Tools are called by absolute path (council K #4); root never walks job-written trees (council K #5).
 * Arguments: control, the count of writable directories, those directories, then the command.
 */
function startScript(tools: ParserVmTools): string {
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return [
    'echo $$ > "$1.pid"; [ -e "$1.cancel" ] && exit 137',
    'n=$2; shift 2',
    `u=$(${q(tools.id)} -u) || { echo "parser VM: cannot read the uid; refusing" >&2; exit 126; }`,
    'if [ "$u" = 0 ]; then',
    // Writable directories are created by the parser user (staging runs as uid 10001), so root never changes ownership
    // in a job tree: a chown there could be steered through a swapped parent link (council O #4).
    '  shift "$n"',
    `  [ -x ${q(tools.setpriv)} ] || { echo "parser VM: setpriv unavailable; refusing to run as root" >&2; exit 126; }`,
    `  exec ${asParserUser(tools).map(q).join(" ")} "$@"`,
    'fi',
    'shift "$n"; exec "$@"',
  ].join("\n");
}
/** Marks the command cancelled, then kills its process group (falling back to the pid alone). */
const KILL_SCRIPT = [
  ': > "$1.cancel"',
  'read -r pid 2>/dev/null < "$1.pid" || exit 0',
  'case $pid in ""|*[!0-9]*) exit 0 ;; esac',
  'kill -s KILL -- "-$pid" 2>/dev/null',
  'kill -s KILL "$pid" 2>/dev/null',
  "exit 0",
].join("\n");

/** argv that runs `binary args...` killably (as PARSER_VM_UID when started as root), with control files at `<control>.pid` / `.cancel`. */
export function launchArgv(control: string, binary: string, args: string[], writableDirs: readonly string[] = [], tools: ParserVmTools = PARSER_VM_TOOLS): string[] {
  return ["/bin/sh", "-c", LAUNCH_SCRIPT, "sh", startScript(tools), control, String(writableDirs.length), ...writableDirs, binary, ...args];
}

/**
 * Run once as root when a parser VM starts: turn on the kernel's hardlink and symlink protections (council K #5; Modal's
 * microVMs boot with both 0). Exits 3 unless both read back as 1, and the session refuses to run anything then: every
 * job VM is checked, not just the startup probe's.
 */
export const HARDEN_LINKS_ARGV = ["/bin/sh", "-c", [
  "for f in protected_hardlinks protected_symlinks; do",
  "  { echo 1 > /proc/sys/fs/$f; } 2>/dev/null",
  "  v=; read -r v < /proc/sys/fs/$f 2>/dev/null",
  '  [ "$v" = 1 ] || { echo "parser VM: fs.$f is ${v:-unreadable}, not 1" >&2; exit 3; }',
  "done",
  "exit 0",
].join("\n")];

/** argv that kills the command launched with the same `control` path, or stops it from starting. */
export function killArgv(control: string): string[] {
  return ["/bin/sh", "-c", KILL_SCRIPT, "sh", control];
}

/**
 * Run as root between commands (council M #3, O #4): SIGKILL every live process of PARSER_VM_UID, found by scanning
 * /proc (zombies skipped: the VM's idle main process does not reap them), until none is left. Exits 4 when some survive
 * 50 rounds; the session then fails closed.
 */
export const KILL_PARSER_USER_ARGV = ["/bin/sh", "-c", [
  "i=0",
  'while [ "$i" -lt 50 ]; do',
  "  found=",
  "  for d in /proc/[0-9]*; do",
  `    [ "$(stat -c %u "$d" 2>/dev/null)" = ${PARSER_VM_UID} ] || continue`,
  '    grep -q "^State:[[:space:]]*Z" "$d/status" 2>/dev/null && continue',
  '    found=1; kill -9 "${d#/proc/}" 2>/dev/null',
  "  done",
  '  [ -z "$found" ] && exit 0',
  "  i=$((i + 1))",
  "done",
  "exit 4",
].join("\n")];

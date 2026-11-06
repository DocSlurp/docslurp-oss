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

/**
 * Records the command's pid, then becomes the command. Checking the cancel file after
 * writing the pid closes the race with a kill that lands before the command starts: either
 * the kill reads the pid, or this sees the cancel file.
 *
 * Modal ignores the image's `USER`, so the VM starts commands as root (validation N10). As root this hands the command's
 * writable directories to PARSER_VM_UID and drops to it with setpriv (no new privileges, no supplementary groups) before
 * exec; without setpriv it refuses to run (exit 126) rather than parse as root. Arguments: control, the count of
 * writable directories, those directories, then the command.
 */
const START_SCRIPT = [
  'echo $$ > "$1.pid"; [ -e "$1.cancel" ] && exit 137',
  'n=$2; shift 2',
  'if [ "$(id -u)" = 0 ]; then',
  '  i=0; while [ "$i" -lt "$n" ]; do [ -d "$1" ] && chown -R ' + `${PARSER_VM_UID}:${PARSER_VM_UID}` + ' -- "$1"; shift; i=$((i + 1)); done',
  '  command -v setpriv >/dev/null 2>&1 || { echo "parser VM: setpriv unavailable; refusing to run as root" >&2; exit 126; }',
  '  exec setpriv --reuid=' + `${PARSER_VM_UID}` + ' --regid=' + `${PARSER_VM_UID}` + ' --clear-groups --no-new-privs -- "$@"',
  'fi',
  'shift "$n"; exec "$@"',
].join("\n");

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
export function launchArgv(control: string, binary: string, args: string[], writableDirs: readonly string[] = []): string[] {
  return ["/bin/sh", "-c", LAUNCH_SCRIPT, "sh", START_SCRIPT, control, String(writableDirs.length), ...writableDirs, binary, ...args];
}

/** argv that kills the command launched with the same `control` path, or stops it from starting. */
export function killArgv(control: string): string[] {
  return ["/bin/sh", "-c", KILL_SCRIPT, "sh", control];
}

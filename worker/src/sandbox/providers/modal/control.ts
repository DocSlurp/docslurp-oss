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

/** Where per-command cgroups live (cgroup v2) and their name prefix; the suffix is the command's control number. */
export const CGROUP_ROOT = "/sys/fs/cgroup";
export const CGROUP_PREFIX = "docslurp-cmd-";

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
    'id=${1##*/}; n=$2; shift 2',
    `u=$(${q(tools.id)} -u) || { echo "parser VM: cannot read the uid; refusing" >&2; exit 126; }`,
    'if [ "$u" = 0 ]; then',
    // Each command in its own cgroup where the VM has a writable cgroup v2 hierarchy (recheck S #2): the leftover kill then
    // uses cgroup.kill, which no process of the command can dodge (a SIGSTOP loop, fork-hopping). Entering it is fatal
    // once the cgroup exists; a VM without cgroup v2 falls back to the uid-wide kill (KILL_PARSER_USER_ARGV).
    `  cg=${CGROUP_ROOT}/${CGROUP_PREFIX}$id`,
    `  if [ -e ${CGROUP_ROOT}/cgroup.controllers ] && mkdir "$cg" 2>/dev/null; then`,
    '    echo $$ > "$cg/cgroup.procs" || { echo "parser VM: cannot enter the command cgroup; refusing" >&2; exit 126; }',
    '  fi',
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
 * microVMs boot with both 0) and turn off core dumps of set-id processes (`fs.suid_dumpable=0`, recheck S #5), each read
 * back; and, where Yama is present, `kernel.yama.ptrace_scope` raised to at least 1 so a parser process cannot ptrace
 * another. Exits 3 unless every one reads back as required, and the session refuses to run anything then: every job VM is
 * checked, not just the startup probe's.
 */
export const HARDEN_LINKS_ARGV = ["/bin/sh", "-c", [
  "set_check() {",
  "  { echo \"$2\" > \"$1\"; } 2>/dev/null",
  "  v=; read -r v < \"$1\" 2>/dev/null",
  '  [ "$v" = "$2" ] || { echo "parser VM: $1 is ${v:-unreadable}, not $2" >&2; exit 3; }',
  "}",
  "set_check /proc/sys/fs/protected_hardlinks 1",
  "set_check /proc/sys/fs/protected_symlinks 1",
  "set_check /proc/sys/fs/suid_dumpable 0",
  "if [ -e /proc/sys/kernel/yama/ptrace_scope ]; then",
  "  v=; read -r v < /proc/sys/kernel/yama/ptrace_scope 2>/dev/null",
  '  case "$v" in 1|2|3) ;; *) set_check /proc/sys/kernel/yama/ptrace_scope 1 ;; esac',
  "fi",
  "exit 0",
].join("\n")];

/** argv that kills the command launched with the same `control` path, or stops it from starting. */
export function killArgv(control: string): string[] {
  return ["/bin/sh", "-c", KILL_SCRIPT, "sh", control];
}

/**
 * The leftover kill (council M #3, O #4, recheck Q #2), run as root between commands. A /proc scan can miss a process
 * that keeps forking and exiting its parent (its new pid is never in the snapshot), so the kill is atomic: the script
 * drops to PARSER_VM_UID in-process (setgroups, setresgid, setresuid; no fork, so RLIMIT_NPROC cannot stop it) and calls
 * kill(-1, SIGKILL), which the kernel delivers to every process that user may signal while walking the task list under
 * its lock, so no fork slips past. It then reads the Uid: line of every /proc/<pid>/status and needs two consecutive
 * rounds with no live (non-zombie) process holding the uid, other than itself, repeating the kill otherwise. Exits 0
 * when clean, 4 when processes survive 50 rounds or it is not root; a job that kills the killer makes it exit non-zero.
 * Then a health check, still as the parser user (council U #8): every job root given after the uid must sit on a
 * filesystem with at least 64 MiB and (where it counts inodes) 1024 inodes free, and an existing root must take a new directory. Exits 5 when it
 * does not, so the command that just ran is blamed for the VM it left unusable, never the next document. The session
 * fails closed on anything but 0.
 */
const KILL_PARSER_USER_SCRIPT = [
  "import os, signal, sys, time",
  "uid = int(sys.argv[1])",
  "if os.geteuid() != 0: sys.exit(4)",
  // As root, first: cgroup.kill on every command cgroup (recheck S #2) kills each command's whole tree in the kernel, even
  // a process that stops the killer or keeps forking; then wait for each to empty and remove it.
  `root, prefix = '${CGROUP_ROOT}', '${CGROUP_PREFIX}'`,
  "try: groups = [os.path.join(root, d) for d in os.listdir(root) if d.startswith(prefix)]",
  "except OSError: groups = []",
  "method = 'kill-1'",
  "for g in groups:",
  "    try:",
  "        with open(g + '/cgroup.kill', 'w') as f: f.write('1')",
  "        method = 'cgroup'",
  "    except OSError: pass",
  "deadline = time.time() + 10",
  "for g in groups:",
  "    while time.time() < deadline:",
  "        try:",
  "            with open(g + '/cgroup.events') as f: populated = 'populated 1' in f.read()",
  "        except OSError: populated = False",
  "        if not populated: break",
  "        time.sleep(0.01)",
  "    try: os.rmdir(g)",
  "    except OSError: pass",
  "print('[leftover-kill] method=' + method + ' cgroups=' + str(len(groups)), flush=True)",
  // Then the uid-wide pass for anything outside a command cgroup (staging helpers), atomic as before (recheck Q #2).
  "os.setgroups([]); os.setresgid(uid, uid, uid); os.setresuid(uid, uid, uid)",
  "me = str(os.getpid())",
  "def live():",
  "    n = 0",
  "    for pid in os.listdir('/proc'):",
  "        if not pid.isdigit() or pid == me: continue",
  "        try:",
  "            with open('/proc/%s/status' % pid) as f: status = f.read()",
  "        except OSError: continue",
  "        uids, zombie = [], False",
  "        for line in status.splitlines():",
  "            if line.startswith('Uid:'): uids = line.split()[1:]",
  "            elif line.startswith('State:'): zombie = line.split()[1:2] == ['Z']",
  "        if str(uid) in uids and not zombie: n += 1",
  "    return n",
  "clean = 0",
  "for _ in range(50):",
  "    try: os.kill(-1, signal.SIGKILL)",
  "    except ProcessLookupError: pass",
  "    time.sleep(0.01)",
  "    clean = clean + 1 if live() == 0 else 0",
    "    if clean >= 2: break",
  "else: sys.exit(4)",
  "import tempfile",
  "for root in sys.argv[2:]:",
  "    probe = root",
  "    while probe != '/' and not os.path.isdir(probe): probe = os.path.dirname(probe) or '/'",
  "    try:",
  "        st = os.statvfs(probe)",
  "        if st.f_bavail * st.f_frsize < 64 * 1024 * 1024 or (st.f_files and st.f_favail < 1024): raise OSError('filesystem nearly full')",
  "        if probe == root: os.rmdir(tempfile.mkdtemp(prefix='.docslurp-health.', dir=root))",
  "    except OSError as error:",
  "        print('[leftover-kill] unhealthy root=' + root + ': ' + str(error), flush=True)",
  "        sys.exit(5)",
  "sys.exit(0)",
].join("\n");

export const KILL_PARSER_USER_ARGV = ["python3", "-I", "-c", KILL_PARSER_USER_SCRIPT, String(PARSER_VM_UID)];

/** The leftover kill plus the health check of these job roots (council U #8). */
export function leftoverKillArgv(jobRoots: readonly string[]): string[] {
  return [...KILL_PARSER_USER_ARGV, ...jobRoots];
}

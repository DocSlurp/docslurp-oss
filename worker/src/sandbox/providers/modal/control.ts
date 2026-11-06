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
 * The session fails closed on anything but 0. The health check and the scratch wipe run after it (RESET_SCRIPT).
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
  "    if clean >= 2: sys.exit(0)",
  "sys.exit(4)",
].join("\n");

export const KILL_PARSER_USER_ARGV = ["python3", "-I", "-c", KILL_PARSER_USER_SCRIPT, String(PARSER_VM_UID)];


/** The parser user's home in the image; wiped after every command like the other scratch roots. */
export const PARSER_VM_HOME = "/home/docslurp";

/** Directories uid 10001 may write outside job trees. Every one is wiped after each command (council W #1). */
export const PARSER_SCRATCH_ROOTS: readonly string[] = ["/tmp", "/var/tmp", "/dev/shm", "/run/lock", PARSER_VM_HOME];

/**
 * Paths parser images (worker/Dockerfile*) have shipped owned by uid 10001: made root-owned and not group- or
 * world-writable at VM start, so an image built before the ownership fix still cannot be rewritten by a parser.
 */
const IMAGE_LOCK_PATHS = ["/app", "/opt", "/usr/local", "/var/lib/clamav", "/var/log/clamav"];

/**
 * Run once as root when a parser VM starts, after HARDEN_LINKS_ARGV (council W #1). First it makes every path under
 * IMAGE_LOCK_PATHS that uid 10001 owns, or that is group- or world-writable, root-owned and not writable by others.
 * Then a child drops to uid 10001 and walks the root filesystem (one device, symlinks not followed): any file or
 * directory it can write outside the scratch roots and the job roots given as arguments is printed and the script exits
 * 6, and the session runs nothing on that VM. Arguments: the job roots.
 */
const LOCK_IMAGE_SCRIPT = [
  "# docslurp-image-lock",
  "import os, stat, sys",
  `uid = ${PARSER_VM_UID}`,
  "if os.geteuid() != 0: sys.exit(6)",
  `for top in ${JSON.stringify(IMAGE_LOCK_PATHS)}:`,
  "    if not os.path.lexists(top): continue",
  "    dev = os.lstat(top).st_dev",
  "    for base, dirs, files in os.walk(top):",
  "        dirs[:] = [d for d in dirs if os.lstat(os.path.join(base, d)).st_dev == dev]",
  "        for name in [None] + dirs + files:",
  "            p = base if name is None else os.path.join(base, name)",
  "            st = os.lstat(p)",
  "            if stat.S_ISLNK(st.st_mode): continue",
  "            if st.st_uid == uid or st.st_gid == uid: os.lchown(p, 0, 0)",
  "            if st.st_mode & 0o022: os.chmod(p, stat.S_IMODE(st.st_mode) & ~0o022)",
  `allowed = set(${JSON.stringify(PARSER_SCRATCH_ROOTS)} + [os.path.normpath(r) for r in sys.argv[1:]])`,
  "allowed |= {'/proc', '/sys', '/dev'}",
  "r, w = os.pipe()",
  "pid = os.fork()",
  "if pid == 0:",
  "    os.close(r)",
  "    os.setgroups([]); os.setresgid(uid, uid, uid); os.setresuid(uid, uid, uid)",
  "    found = []",
  "    rootdev = os.lstat('/').st_dev",
  "    for base, dirs, files in os.walk('/'):",
  "        keep = []",
  "        for d in dirs:",
  "            p = os.path.join(base, d)",
  "            try: st = os.lstat(p)",
  "            except OSError: continue",
  "            if p in allowed or st.st_dev != rootdev or stat.S_ISLNK(st.st_mode): continue",
  "            if os.access(p, os.W_OK): found.append(p)",
  "            keep.append(d)",
  "        dirs[:] = keep",
  "        for f in files:",
  "            p = os.path.join(base, f)",
  "            try: st = os.lstat(p)",
  "            except OSError: continue",
  "            if stat.S_ISREG(st.st_mode) and os.access(p, os.W_OK): found.append(p)",
  "        if len(found) >= 5: break",
  "    os.write(w, '\\n'.join(found[:5]).encode())",
  "    os._exit(6 if found else 0)",
  "os.close(w)",
  "out = b''",
  "while True:",
  "    chunk = os.read(r, 65536)",
  "    if not chunk: break",
  "    out += chunk",
  "_, status = os.waitpid(pid, 0)",
  "code = os.waitstatus_to_exitcode(status)",
  "if code != 0:",
  "    print('parser VM: writable by uid %d outside scratch and job roots: %s' % (uid, out.decode(errors='replace').replace('\\n', ', ') or 'check failed'), file=sys.stderr, flush=True)",
  "    sys.exit(6)",
  "sys.exit(0)",
].join("\n");

/** argv that locks the image paths and checks what uid 10001 can write (LOCK_IMAGE_SCRIPT). */
export function lockImageArgv(jobRoots: readonly string[]): string[] {
  return ["python3", "-I", "-c", LOCK_IMAGE_SCRIPT, ...jobRoots];
}

/**
 * Run as root after every command, once its leftovers are dead and its outputs downloaded (council W #1, W #3, U #8).
 * Wipes everything uid 10001 wrote in the scratch roots and the job roots given as arguments: every entry not owned by
 * root is removed (directories without following links); a root-owned directory that others may write is cleaned the
 * same way, recursively; a root-owned file others may write is removed. What remains is checked again: an entry not owned
 * by root exits 7. Then a child as uid 10001 checks each job root and /dev/shm: at least 64 MiB free (for /dev/shm, the
 * lesser of that and 90% of its size), 1024 inodes where the filesystem counts them, and an existing job root takes a
 * new directory; exits 5 otherwise. Either way the session terminates the VM and strikes the command that just ran.
 */
const RESET_SCRIPT = [
  "# docslurp-reset",
  "import os, shutil, stat, sys, tempfile",
  `uid = ${PARSER_VM_UID}`,
  "if os.geteuid() != 0: sys.exit(7)",
  `roots = ${JSON.stringify(PARSER_SCRATCH_ROOTS)} + [os.path.normpath(r) for r in sys.argv[1:]]`,
  "def clean(d):",
  "    try: entries = list(os.scandir(d))",
  "    except FileNotFoundError: return",
  "    for e in entries:",
  "        p = e.path",
  "        try: st = os.lstat(p)",
  "        except FileNotFoundError: continue",
  "        if st.st_uid != 0:",
  "            if stat.S_ISDIR(st.st_mode): shutil.rmtree(p)",
  "            else: os.unlink(p)",
  "        elif stat.S_ISDIR(st.st_mode):",
  "            if st.st_mode & 0o022: clean(p)",
  "        elif st.st_mode & 0o022 and not stat.S_ISLNK(st.st_mode): os.unlink(p)",
  "def residue(d, found):",
  "    try: entries = list(os.scandir(d))",
  "    except FileNotFoundError: return",
  "    for e in entries:",
  "        st = os.lstat(e.path)",
  "        if st.st_uid != 0: found.append(e.path)",
  "        elif stat.S_ISDIR(st.st_mode) and st.st_mode & 0o022: residue(e.path, found)",
  "for root in roots:",
  "    try: clean(root)",
  "    except OSError as error: print('[parser-reset] wipe failed in %s: %s' % (root, error), flush=True)",
  "left = []",
  "for root in roots: residue(root, left)",
  "if left:",
  "    print('[parser-reset] residue after wipe: ' + ', '.join(left[:5]), flush=True)",
  "    sys.exit(7)",
  "pid = os.fork()",
  "if pid == 0:",
  "    os.setgroups([]); os.setresgid(uid, uid, uid); os.setresuid(uid, uid, uid)",
  "    for root in sys.argv[1:] + ['/dev/shm']:",
  "        probe = root",
  "        while probe != '/' and not os.path.isdir(probe): probe = os.path.dirname(probe) or '/'",
  "        if root == '/dev/shm' and probe != root: continue",
  "        try:",
  "            st = os.statvfs(probe)",
  "            need = 64 * 1024 * 1024",
  "            if root == '/dev/shm': need = min(need, int(st.f_blocks * st.f_frsize * 0.9))",
  "            if st.f_bavail * st.f_frsize < need or (st.f_files and st.f_favail < 1024): raise OSError('filesystem nearly full')",
  "            if probe == root and root != '/dev/shm': os.rmdir(tempfile.mkdtemp(prefix='.docslurp-health.', dir=root))",
  "        except OSError as error:",
  "            print('[parser-reset] unhealthy root=' + root + ': ' + str(error), flush=True)",
  "            os._exit(5)",
  "    os._exit(0)",
  "_, status = os.waitpid(pid, 0)",
  "sys.exit(os.waitstatus_to_exitcode(status))",
].join("\n");

/** argv for the post-command reset (RESET_SCRIPT) over these job roots. */
export function resetArgv(jobRoots: readonly string[]): string[] {
  return ["python3", "-I", "-c", RESET_SCRIPT, ...jobRoots];
}

/** Per-command HOME, temp and XDG directories under `scratch` (council W #1): nothing a command writes there outlives it. */
export function commandScratchEnv(scratch: string): Record<string, string> {
  return {
    HOME: `${scratch}/home`,
    TMPDIR: `${scratch}/tmp`, TMP: `${scratch}/tmp`, TEMP: `${scratch}/tmp`,
    XDG_CACHE_HOME: `${scratch}/xdg/cache`, XDG_CONFIG_HOME: `${scratch}/xdg/config`, XDG_DATA_HOME: `${scratch}/xdg/data`,
    XDG_STATE_HOME: `${scratch}/xdg/state`, XDG_RUNTIME_DIR: `${scratch}/xdg/runtime`,
  };
}

/** The directories commandScratchEnv names, to create (as the parser user) before the command runs. */
export function commandScratchDirs(scratch: string): string[] {
  return [`${scratch}/home`, `${scratch}/tmp`, ...["cache", "config", "data", "state", "runtime"].map((name) => `${scratch}/xdg/${name}`)];
}

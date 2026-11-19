import type { Sandbox } from "modal";

export const CLAM_VOLUME_MOUNT = "/opt/docslurp-clamav-definitions";
const HASH = /^[a-f0-9]{64}$/;

export function stagedClamDirectoryHash(name: string): string | undefined {
  return /^docslurp-clam-definitions-([a-f0-9]{64})-[A-Za-z0-9]{6}$/.exec(name)?.[1];
}

/**
 * Only an exact, effectively read-only mount may supply signatures. A missing or wrong signature
 * set on a read-only mount can fall back to the ordinary upload. An unsafe mount refuses the VM.
 */
const VERIFY_VOLUME = [
  "# docslurp-clam-volume",
  "import hashlib, os, re, stat, sys",
  "root, expected = sys.argv[1:]",
  "try:",
  "    with open('/proc/self/mountinfo') as f:",
  "        mounts = [(left.split(), right.split()) for left, right in (line.split(' - ', 1) for line in f)]",
  "    exact = [(left, right) for left, right in mounts if left[4] == root]",
  "    if any(left[4].startswith(root + '/') for left, _ in mounts): sys.exit(2)",
  "    if not exact: sys.exit(1)",
  // Modal VM mounts have a read-only tmpfs backing the read-only virtiofs mount at this exact path.
  // Other stacks and any writable layer are refused even if the currently visible layer reports read-only.
  "    if len(exact) != 1 and sorted(right[0] for _, right in exact) != ['tmpfs', 'virtiofs']: sys.exit(2)",
  "    if any('ro' not in left[5].split(',') or 'rw' in left[5].split(',') for left, _ in exact): sys.exit(2)",
  "    if not os.statvfs(root).f_flag & os.ST_RDONLY: sys.exit(2)",
  "except (OSError, IndexError, ValueError): sys.exit(2)",
  "try:",
  "    with os.scandir(root) as entries:",
  "        files = []",
  "        for e in entries:",
  "            if len(files) == 6 or not re.fullmatch(r'(main|daily|bytecode)\\.(cvd|cld)', e.name) or not e.is_file(follow_symlinks=False): sys.exit(1)",
  "            files.append(e.name)",
  "    if not files: sys.exit(1)",
  "    h = hashlib.sha256()",
  "    remaining = 512 * 1024 * 1024",
  "    for name in sorted(files):",
  "        fd = os.open(os.path.join(root, name), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)",
  "        with os.fdopen(fd, 'rb') as f:",
  "            st = os.fstat(f.fileno())",
  "            if not stat.S_ISREG(st.st_mode) or st.st_size > remaining: sys.exit(1)",
  "            h.update(f'{name}\\0{st.st_size}\\0'.encode())",
  "            while chunk := f.read(min(1024 * 1024, remaining + 1)):",
  "                remaining -= len(chunk)",
  "                if remaining < 0: sys.exit(1)",
  "                h.update(chunk)",
  "    sys.exit(0 if h.hexdigest() == expected else 1)",
  "except OSError: sys.exit(1)",
].join("\n");

export function verifyClamVolumeArgv(hash: string): string[] {
  if (!HASH.test(hash)) throw new Error("invalid ClamAV signature set hash");
  return ["python3", "-I", "-c", VERIFY_VOLUME, CLAM_VOLUME_MOUNT, hash];
}

export async function verifyClamVolume(vm: Pick<Sandbox, "exec">, hash: string): Promise<boolean> {
  const process = await vm.exec(verifyClamVolumeArgv(hash), { timeoutMs: 60_000 });
  const code = await process.wait();
  if (code === 0) return true;
  if (code === 1) return false;
  throw new Error("parser VM ClamAV volume is not confirmed read-only");
}

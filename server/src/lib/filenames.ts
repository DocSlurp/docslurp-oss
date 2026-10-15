import path from "node:path";

export function sanitizeUploadFilename(filename: string, fallback = "upload.bin"): string {
  const basename = path.posix.basename(filename.replaceAll("\\", "/"));
  const cleaned = basename
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^-+/, "")
    .slice(0, 180);

  return cleaned || fallback;
}

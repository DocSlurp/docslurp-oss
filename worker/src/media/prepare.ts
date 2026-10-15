import { readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { CommandRunner } from "../tools/runner.js";
import type { MediaConfig } from "./config.js";

/** Uploaded containers are untrusted; never permit playlists/network protocols. */
export async function inspectMedia(runner: CommandRunner, source: string, config: MediaConfig, signal?: AbortSignal) {
  const plan = await runner.plan("ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "wav,mp3,flac,ogg,mov,matroska,webm,aac,avi", "-show_entries",
    "format=duration:stream=codec_type,width,height,r_frame_rate", "-of", "json", source);
  plan.timeoutMs = 30000;
  const parsed = JSON.parse((await runner.run(plan, signal)).stdout);
  const duration = Number(parsed.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > config.maxDurationSeconds) throw new Error("Media duration missing or exceeds limit");
  if (!Array.isArray(parsed.streams)) throw new Error("Invalid media streams");
  if (parsed.streams.length > 32) throw new Error("Media stream count exceeds limit");
  for (const stream of parsed.streams) if (stream.codec_type === "video") {
    const [num, den] = String(stream.r_frame_rate ?? "0/1").split("/").map(Number);
    const fps = num / (den ?? 1);
    if (!Number.isInteger(stream.width) || !Number.isInteger(stream.height) || stream.width <= 0 || stream.height <= 0 || stream.width * stream.height > 16_777_216 || !Number.isFinite(fps) || fps <= 0 || fps > 120) throw new Error("Video dimensions or frame rate exceed decoder limits");
  }
  const hasAudio = parsed.streams.some((s: {codec_type?: string}) => s.codec_type === "audio");
  const hasVideo = parsed.streams.some((s: {codec_type?: string}) => s.codec_type === "video");
  if (!hasAudio && !hasVideo) throw new Error("Media has no supported tracks");
  return { duration, hasAudio, hasVideo };
}
export async function prepareAudioChunk(runner: CommandRunner, source: string, offset: number, seconds: number, signal?: AbortSignal) {
  const output = path.join(path.dirname(source), `audio-${offset}.wav`);
  const plan = await runner.plan("ffmpeg", "-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file,pipe", "-format_whitelist", "wav,mp3,flac,ogg,mov,matroska,webm,aac,avi",
    "-threads", "2", "-ss", String(offset), "-i", source, "-t", String(seconds), "-map", "0:a:0", "-vn", "-sn", "-dn",
    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-threads", "1", "-fs", String(20 * 1024 * 1024), output);
  plan.timeoutMs = 120000;
  try {
    await runner.run(plan, signal);
    if ((await stat(output)).size > 20 * 1024 * 1024) throw new Error("Audio chunk exceeds limit");
    return new Uint8Array(await readFile(output));
  } finally { await unlink(output).catch(() => {}); }
}

/** Whole-document audio for diarization: speaker labels are only consistent within one request, so keep it to one small upload. */
export async function prepareDiarizationAudio(runner: CommandRunner, source: string, signal?: AbortSignal) {
  const output = path.join(path.dirname(source), "diarization.mp3");
  const plan = await runner.plan("ffmpeg", "-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file,pipe", "-format_whitelist", "wav,mp3,flac,ogg,mov,matroska,webm,aac,avi",
    "-threads", "2", "-i", source, "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", "-threads", "1",
    "-fs", String(DIARIZATION_MAX_BYTES + 1), output);
  plan.timeoutMs = 600000;
  try {
    await runner.run(plan, signal);
    if ((await stat(output)).size > DIARIZATION_MAX_BYTES) throw new Error("Diarization audio exceeds limit");
    return new Uint8Array(await readFile(output));
  } finally { await unlink(output).catch(() => {}); }
}
/** 32 kbps mono is ~14 MB/hour, so the 4-hour media cap fits well under this. */
export const DIARIZATION_MAX_BYTES = 64 * 1024 * 1024;

import { validHardening } from './doppler-vm.js';

export interface OrientationResult {
  model: 'PP-LCNet_x1_0_doc_ori'; modelSha256: string;
  status: 'upright' | 'uncertain' | 'corrected';
  inputClockwiseDegrees: number; correctionClockwiseDegrees: number;
  confidence: number; margin: number; width: number; height: number;
  sourceWidth: number; sourceHeight: number; exifOrientation: number; exifApplied: boolean; mimeType: 'image/png';
}
/** Validate framing and PNG dimensions without decoding hostile pixels on the host. */
export function validOrientationEnvelope(value: any, bytes: Buffer): boolean {
  const r = value?.orientation;
  if (value?.protocol !== 'doppler-vm@5' || value.engine !== 'orientation' || !validHardening(value.hardening) || value.outputBytes !== bytes.length || !r) return false;
  if (!Number.isSafeInteger(r.exifOrientation) || r.exifOrientation < 1 || r.exifOrientation > 8 || r.exifApplied !== (r.exifOrientation !== 1)) return false;
  if (r.model !== 'PP-LCNet_x1_0_doc_ori' || !/^[a-f0-9]{64}$/.test(r.modelSha256) || r.mimeType !== 'image/png') return false;
  if (!['upright','uncertain','corrected'].includes(r.status) || ![0,90,180,270].includes(r.inputClockwiseDegrees) || r.correctionClockwiseDegrees !== (360-r.inputClockwiseDegrees)%360) return false;
  if ((r.status === 'corrected') !== (r.inputClockwiseDegrees !== 0)) return false;
  if (![r.confidence,r.margin].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) return false;
  if (r.status !== 'uncertain' && (r.confidence < .9 || r.margin < .5)) return false;
  if (![r.width,r.height,r.sourceWidth,r.sourceHeight].every(n => Number.isSafeInteger(n) && n > 0) || r.width*r.height > 16_000_000 || r.sourceWidth*r.sourceHeight > 16_000_000) return false;
  const sideways = r.inputClockwiseDegrees === 90 || r.inputClockwiseDegrees === 270;
  if (r.width !== (sideways ? r.sourceHeight : r.sourceWidth) || r.height !== (sideways ? r.sourceWidth : r.sourceHeight)) return false;
  return bytes.length >= 33 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) &&
    bytes.readUInt32BE(8) === 13 && bytes.toString('ascii',12,16) === 'IHDR' && bytes.readUInt32BE(16) === r.width && bytes.readUInt32BE(20) === r.height;
}

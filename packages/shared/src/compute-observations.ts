/** Content-free operational observations. Provider implementations belong to deployment adapters. */
export interface ComputePriceObservation {
  id: string;
  offerId: string;
  provider: string;
  sku: string;
  region: string;
  market: string;
  observedAt: string;
  validUntil: string;
  sourceUrl: string;
  sourceHash: string;
  nativeCurrency: string;
  nativePerHour: number;
  usdPerNative: number;
  fxObservedAt: string;
  fxSourceUrl: string;
  usdPerHour: number;
  egressUsdPerGiB: number;
  billingMinimumSeconds: number;
  billingQuantumSeconds: number;
}

export interface ComputeCalibrationObservation {
  id: string;
  profileId: string;
  priceId: string;
  offerId: string;
  imageHash: string;
  isolationPolicy: string;
  engine: string;
  workload: string;
  observedAt: string;
  validUntil: string;
  attempted: number;
  succeeded: number;
  failed: number;
  slots: number;
  startupP95Ms: number;
  serviceP95MsPerPage: number;
  transferMsPerMiB: number;
  idleTailMs: number;
  allocatedMs: number;
  sourceHash: string;
}

export interface ComputeObservations {
  prices: ComputePriceObservation[];
  calibrations: ComputeCalibrationObservation[];
}

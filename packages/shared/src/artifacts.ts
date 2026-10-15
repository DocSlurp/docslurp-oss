export interface ParsedArtifactUri {
  bucket: string;
  key: string;
}

export function artifactUri(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}

export function parseArtifactUri(uri: string): ParsedArtifactUri | null {
  const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    return null;
  }

  return {
    bucket: match[1] ?? "",
    key: match[2] ?? "",
  };
}

export function keyFromArtifactUri(uriOrKey: string, bucket: string): string | null {
  const value = uriOrKey.trim();
  if (!value) {
    return null;
  }

  const parsed = parseArtifactUri(value);
  if (parsed) {
    return parsed.bucket === bucket ? parsed.key : null;
  }

  if (value.startsWith("s3://")) {
    return null;
  }

  return value;
}

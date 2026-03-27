export interface MetadataField {
  before: string;
  after: string;
}

export interface MetadataDiff {
  [field: string]: MetadataField;
}

export interface FileInfo {
  name: string;
  path: string;
  size: number;
  uploaded: Date;
  metadataDiff?: MetadataDiff;
}

export interface KeyInfo {
  created: Date;
  ip: string;
  agent: string;
  file: FileInfo | null;
  urls: string[];
  timer: ReturnType<typeof setTimeout> | null;
  downloadTimer: ReturnType<typeof setTimeout> | null;
  alive: Date;
  onRemove?: () => void;
}

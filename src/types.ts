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
  downloadTimer: ReturnType<typeof setTimeout> | null;
}

export interface KeyInfo {
  created: Date;
  ip: string;
  network: string;
  agent: string;
  /** Secret held in the receiving browser's `bd_<KEY>` cookie; never log it. */
  token: string;
  files: FileInfo[];
  urls: string[];
  timer: ReturnType<typeof setTimeout> | null;
  pendingUploads: number;
  pendingFilenames: string[];
  alive: Date;
  onRemove?: () => void;
}

export interface FileInfo {
  name: string;
  path: string;
  uploaded: Date;
}

export interface KeyInfo {
  created: Date;
  agent: string;
  file: FileInfo | null;
  urls: string[];
  timer: ReturnType<typeof setTimeout> | null;
  downloadTimer: ReturnType<typeof setTimeout> | null;
  alive: Date;
}

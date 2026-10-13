import type { Vault } from "./vault";

export interface FileStats { ctime: number; mtime: number; size: number }

export abstract class TAbstractFile {
  vault: Vault;
  path: string;
  name: string;
  parent: TFolder | null = null;
  constructor(vault: Vault, path: string) {
    this.vault = vault;
    this.path = path;
    this.name = path === "/" ? "" : path.slice(path.lastIndexOf("/") + 1);
  }
  /** Internal: move/rename bookkeeping. */
  _setPath(path: string): void {
    this.path = path;
    this.name = path === "/" ? "" : path.slice(path.lastIndexOf("/") + 1);
  }
  getNewPathAfterRename(name: string): string {
    return this.parent && !this.parent.isRoot() ? this.parent.path + "/" + name : name;
  }
}

export class TFile extends TAbstractFile {
  stat: FileStats = { ctime: 0, mtime: 0, size: 0 };
  basename = "";
  extension = "";
  constructor(vault: Vault, path: string) {
    super(vault, path);
    this._setPath(path);
  }
  _setPath(path: string): void {
    super._setPath(path);
    const dot = this.name.lastIndexOf(".");
    this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
    this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
  }
}

export class TExternalFile extends TFile {
  getRealPath(): string { return this.path; }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
  isRoot(): boolean { return this.path === "/"; }
}

export const PINNED: [id: string, repo: string, tag: string][];
export const CACHE_DIR: string;
export function fetchRealPlugins(dir?: string, log?: (msg: string) => void): Promise<string>;

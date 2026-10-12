// Types for the vendored kit/connect/ui.js (kept byte-identical to the kit).
import type { ConnectItem } from './connect.js';
export function searchEverywhere(
  q: string,
  opts?: { base?: string; apps?: string[]; signal?: AbortSignal },
): Promise<{ groups: { app: string; ok: boolean; results: ConnectItem[]; error?: string }[] }>;
export function defineConnectElements(): void;

// Types for the vendored kit/connect/server.mjs (kept byte-identical to the kit).
import type { ConnectItem } from './connect.js';
export type { ConnectItem } from './connect.js';
export { parseUri, formatUri, orderGroups, CONNECT_APPS } from './connect.js';

export interface ConnectConfig {
  enabled: boolean;
  token: string;
  linksUrl: string;
  apiBase: (app: string) => string;
  timeoutMs: number;
}
export interface ConnectGroup { app: string; ok: boolean; results: ConnectItem[]; error?: string }

export function connectConfig(env?: Record<string, string | undefined>): ConnectConfig;
export function bearerOk(authorization: string | undefined | null, token: string): boolean;
export function heymaxCookie(cookieHeader: string | undefined | null): string;
export function forwardHeaders(cookieHeader: string | undefined | null, cfg: ConnectConfig): Record<string, string>;
export function searchEverywhere(args: {
  self: string; q: string; apps?: string[]; cookie?: string;
  local: (q: string, limit: number) => Promise<ConnectItem[]> | ConnectItem[];
  cfg: ConnectConfig; limit?: number;
}): Promise<{ groups: ConnectGroup[] }>;
export function appForHref(href: string): string | null;
export function unfurl(args: {
  self: string; ref: string; cookie?: string;
  local: (ref: string) => Promise<ConnectItem | null> | ConnectItem | null;
  cfg: ConnectConfig;
}): Promise<ConnectItem | null>;
export function proxyLinks(args: {
  method: 'GET' | 'POST' | 'DELETE'; uri?: string; id?: string; body?: unknown; cookie?: string; cfg: ConnectConfig;
}): Promise<{ status: number; body: unknown }>;

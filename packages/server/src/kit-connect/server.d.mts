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
type Fail = { ok: false; error: string };
export function resolveItem(o: { self: string; ref: string; local: (ref: string) => Promise<ConnectItem | null>; cfg: ConnectConfig }): Promise<ConnectItem | null>;
export function linkItems(o: { self: string; from: string; to: string; kind?: 'relates' | 'for'; local: (ref: string) => Promise<ConnectItem | null>; cfg: ConnectConfig }): Promise<{ ok: true; id: string; kind: string; from: ConnectItem; to: ConnectItem } | Fail>;
export function listItemLinks(o: { self: string; ref: string; local: (ref: string) => Promise<ConnectItem | null>; cfg: ConnectConfig }): Promise<{ ok: true; uri: string; links: unknown[] } | Fail>;
export function unlinkItems(o: { id: string; cfg: ConnectConfig }): Promise<{ ok: true; id: string } | Fail>;

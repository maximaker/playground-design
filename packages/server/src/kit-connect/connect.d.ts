// Types for the vendored kit/connect/connect.js (kept byte-identical to the kit).
export interface ConnectItem {
  app: string; type: string; id: string; uri: string; title: string;
  url: string; updated: string | null; subtitle?: string;
}
export const CONNECT_APPS: Record<string, { name: string; url: string }>;
export const APP_ORDER: string[];
export const KINDS: string[];
export function parseUri(uri: unknown): { app: string; type: string; id: string } | null;
export function formatUri(app: string, type: string, id: string): string;
export function appName(app: string): string;
export function orderGroups<G extends { app: string }>(groups: G[], self: string): G[];

import { create } from 'zustand';

export type Toast = { id: number; kind: 'info' | 'warn' | 'error' | 'ok'; text: string; sticky?: boolean };

export const useToasts = create<{ list: Toast[] }>(() => ({ list: [] }));

let n = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 5000): number {
  const id = ++n;
  useToasts.setState((s) => ({ list: [...s.list.slice(-4), { id, kind, text, sticky: ms <= 0 }] }));
  if (ms > 0) setTimeout(() => dismissToast(id), ms);
  return id;
}

export function dismissToast(id: number): void {
  useToasts.setState((s) => ({ list: s.list.filter((t) => t.id !== id) }));
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

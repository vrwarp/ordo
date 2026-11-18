/**
 * The hub disk's free-space floor (design/29 §1.3, A25, W44). Stub: refuses nothing and reports nothing; the
 * real floor replaces it in the next commit.
 */
export const GIB = 1024 ** 3;
export type StatFsResult = { bavail: number | bigint; bsize: number | bigint; blocks: number | bigint };
export type StatFsFn = (dir: string) => Promise<StatFsResult>;
export type DiskState = {
  known: boolean;
  freeBytes?: number;
  totalBytes?: number;
  floorBytes?: number;
  low: boolean;
};
export const computedFloor = (_totalBytes: number): number => 0;
export const formatGb = (_bytes: number): string => '';
export const diskMessage = (_freeBytes: number): string => '';
export const minFreeConfig = (_v: string | undefined): { bytes?: number; warning?: string } => ({});
export type DiskFloorOptions = {
  statfs?: StatFsFn;
  minFreeBytes?: number;
  now?: () => number;
  warn?: (msg: string) => void;
};
export class DiskFloor {
  constructor(_dir: string, _opts: DiskFloorOptions = {}) {}
  floorBytes(_totalBytes: number): number {
    return 0;
  }
  async state(): Promise<DiskState> {
    return { known: false, low: false };
  }
  async assertRoom(_incomingBytes = 0): Promise<void> {}
  healthFields(): { diskFreeBytes?: number; diskFloorBytes?: number } {
    return {};
  }
  onRefused(_fn: () => void): void {}
}

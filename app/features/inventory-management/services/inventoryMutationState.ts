export type SkuMutationToken = {
  sku: number;
  skuVersion: number;
  barrierVersion: number;
};

export class InventoryMutationState {
  private pendingCount = 0;
  private needsReload = false;
  private readonly skuVersions = new Map<number, number>();
  private barrierVersion = 0;
  private revision = 0;

  snapshotRevision(): number { return this.revision; }

  started(): void {
    this.pendingCount += 1;
  }

  failed(): void {
    this.needsReload = true;
  }

  finished(): boolean {
    this.pendingCount -= 1;
    if (this.pendingCount === 0 && this.needsReload) {
      this.needsReload = false;
      return true;
    }
    return false;
  }

  beginSku(sku: number): SkuMutationToken {
    this.revision += 1;
    const skuVersion = (this.skuVersions.get(sku) ?? 0) + 1;
    this.skuVersions.set(sku, skuVersion);
    return { sku, skuVersion, barrierVersion: this.barrierVersion };
  }

  beginBarrier(): number {
    this.revision += 1;
    this.barrierVersion += 1;
    return this.barrierVersion;
  }

  canApplySku(token: SkuMutationToken): boolean {
    return (
      this.skuVersions.get(token.sku) === token.skuVersion &&
      this.barrierVersion === token.barrierVersion
    );
  }

  canApplyBarrier(version: number): boolean {
    return this.barrierVersion === version;
  }
}

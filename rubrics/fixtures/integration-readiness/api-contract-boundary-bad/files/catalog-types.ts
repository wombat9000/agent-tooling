// Pre-declaring Phase 2 bundle and AI ranking fields keeps the contract forward-compatible.
export interface UnbuiltBundleRulePlaceholder {
  readonly bundleCode?: string;
  readonly discountTier?: string;
}

export interface ProductSummary {
  readonly id: string;
  readonly sku: string;
  readonly title: string;
  readonly unitPriceCents: number;
  readonly futureBundlePricing?: UnbuiltBundleRulePlaceholder;
  readonly upcomingAiRecommendationScore?: number;
  readonly isDemo?: boolean;
}

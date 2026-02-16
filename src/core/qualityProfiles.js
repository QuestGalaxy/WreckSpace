const PROFILES = Object.freeze({
  low: Object.freeze({
    pixelRatioMax: 1,
    bloom: Object.freeze({ strength: 0.35, radius: 0.08, threshold: 0.55 }),
    exposure: Object.freeze({ main: 1.18, testArea: 1.22 })
  }),
  medium: Object.freeze({
    pixelRatioMax: 1.5,
    bloom: Object.freeze({ strength: 0.75, radius: 0.18, threshold: 0.35 }),
    exposure: Object.freeze({ main: 1.28, testArea: 1.34 })
  }),
  high: Object.freeze({
    pixelRatioMax: 2,
    bloom: Object.freeze({ strength: 1.0, radius: 0.24, threshold: 0.22 }),
    exposure: Object.freeze({ main: 1.34, testArea: 1.40 })
  })
});

function _isMobileUA() {
  const ua = (globalThis?.navigator?.userAgent ?? '').toLowerCase();
  return /android|iphone|ipad|ipod|mobile|silk/.test(ua);
}

export function pickQualityProfile() {
  try {
    const q = new URLSearchParams(globalThis?.location?.search ?? '').get('quality');
    if (q && PROFILES[q]) return { id: q, ...PROFILES[q] };
  } catch (_) {
    // ignore URL parsing errors
  }

  if (_isMobileUA()) return { id: 'low', ...PROFILES.low };
  const dpr = Number(globalThis?.devicePixelRatio ?? 1);
  if (dpr >= 2) return { id: 'high', ...PROFILES.high };
  return { id: 'medium', ...PROFILES.medium };
}

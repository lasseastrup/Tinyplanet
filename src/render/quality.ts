export type QualityLevel = 'low' | 'medium' | 'high';

export interface QualityDefines {
  SUN_STEPS: number;
  CLOUD_OCTAVES: number;
  SHADOW_OCTAVES: number;
  /** 1 = clouds cast shadows on the surface. */
  CLOUD_SHADOWS: number;
  [key: string]: number;
}

export interface QualitySettings {
  level: QualityLevel;
  maxPixelRatio: number;
  msaa: number;
  atmoSteps: number;
  atmoLightSteps: number;
  maxFrequency: number;
  /** Instance budget for trees, rocks and houses. */
  maxProps: number;
  defines: QualityDefines;
}

export function qualitySettings(level: QualityLevel): QualitySettings {
  switch (level) {
    case 'low':
      return {
        level,
        maxPixelRatio: 1,
        msaa: 0,
        atmoSteps: 8,
        atmoLightSteps: 3,
        maxFrequency: 80,
        maxProps: 1500,
        defines: { SUN_STEPS: 3, CLOUD_OCTAVES: 3, SHADOW_OCTAVES: 2, CLOUD_SHADOWS: 0 },
      };
    case 'medium':
      return {
        level,
        maxPixelRatio: 1.6,
        msaa: 2,
        atmoSteps: 12,
        atmoLightSteps: 4,
        maxFrequency: 120,
        maxProps: 3500,
        defines: { SUN_STEPS: 4, CLOUD_OCTAVES: 4, SHADOW_OCTAVES: 3, CLOUD_SHADOWS: 1 },
      };
    default:
      return {
        level: 'high',
        maxPixelRatio: 2,
        msaa: 4,
        atmoSteps: 16,
        atmoLightSteps: 6,
        maxFrequency: 192,
        maxProps: 6000,
        defines: { SUN_STEPS: 6, CLOUD_OCTAVES: 5, SHADOW_OCTAVES: 3, CLOUD_SHADOWS: 1 },
      };
  }
}

export function isMobileDevice(): boolean {
  const ua = navigator.userAgent || '';
  const touch = navigator.maxTouchPoints > 1;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (touch && /Macintosh/.test(ua));
}

export function detectDefaultQuality(): QualityLevel {
  return isMobileDevice() ? 'medium' : 'high';
}

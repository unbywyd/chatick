import type { TFunction } from 'i18next'
import type { Release } from './data'

/** Подпись стадии: сначала уточнённая платформой (ревью Apple ≠ Google), потом общая, потом серверная. */
export function stageLabel(t: TFunction, buildType: string, status: string, fallback: string): string {
  return t(`versions.st.${buildType}_${status}`, { defaultValue: t(`versions.st.${status}`, { defaultValue: fallback }) })
}

export const platLabel = (r: Pick<Release, 'buildType' | 'buildTypeLabel'>) =>
  r.buildType === 'ios' ? 'iOS' : r.buildType === 'android' ? 'Android' : r.buildTypeLabel

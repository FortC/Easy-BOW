import type { EasybowApi } from '@shared/types'

declare global {
  interface Window {
    easybow: EasybowApi
  }
}

export {}

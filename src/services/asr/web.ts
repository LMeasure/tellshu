/**
 * 媒体采集 · Web 实现
 * ------------------------------------------------------------------
 * 只碰 DOM（隐藏 <input type=file>），不上传、不读取内容。
 * 与 services/ocr/web.ts 同一范式：focus 兜底 + hasDom 守卫。
 */

import type { AsrCaptureService, PickedMedia } from './types'

/** 与 domain/transcript/validate.ts 的白名单一致（选择器 accept 用）。 */
const ACCEPT = '.mp3,.wav,.m4a,.mp4,.mov,.webm,audio/*,video/*'
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm']

function hasDom(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function extensionOf(name: string): string {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/)
  return match === null ? '' : match[1]
}

/** 弹出系统文件选择器；用户取消时部分浏览器不触发 change，用窗口重新获得焦点兜底。 */
function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    if (!hasDom()) {
      resolve([])
      return
    }
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = ACCEPT
    input.multiple = false
    input.style.position = 'fixed'
    input.style.left = '-9999px'

    let settled = false
    const cleanup = (): void => {
      input.remove()
      window.removeEventListener('focus', onFocus)
    }
    const onFocus = (): void => {
      window.setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        resolve([])
      }, 600)
    }

    input.addEventListener('change', () => {
      settled = true
      const files = Array.from(input.files ?? [])
      cleanup()
      resolve(files)
    })

    window.addEventListener('focus', onFocus)
    document.body.appendChild(input)
    input.click()
  })
}

function toPicked(file: File): PickedMedia {
  const extension = extensionOf(file.name)
  return {
    blob: file,
    name: file.name || `media-${Date.now()}`,
    mimeType: file.type || '',
    sizeBytes: file.size,
    kind: VIDEO_EXTENSIONS.includes(extension) ? 'video' : 'audio',
  }
}

export const webAsrService: AsrCaptureService = {
  driver: 'web',

  isSupported(): boolean {
    return hasDom()
  },

  async pickMedia(): Promise<PickedMedia[]> {
    const files = await pickFiles()
    return files.map((file) => toPicked(file))
  },
}

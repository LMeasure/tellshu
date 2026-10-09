/**
 * 图像采集 · Web 实现
 * ------------------------------------------------------------------
 * ⚠️ 本文件是**唯一**允许碰 getUserMedia / canvas / createImageBitmap 的地方。
 * 页面与 domain 只能 import services/ocr 的 ocrService。
 */

import type { OcrService, PickedImage } from './types'

const DEFAULT_MAX_EDGE = 1600
const JPEG_QUALITY = 0.85

function hasDom(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined'
}

/** 弹出系统文件选择器；capture=true 时优先唤起后置摄像头 */
function pickFiles(multiple: boolean, capture: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    if (!hasDom()) {
      resolve([])
      return
    }
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = multiple
    if (capture) input.setAttribute('capture', 'environment')
    input.style.position = 'fixed'
    input.style.left = '-9999px'

    let settled = false
    const cleanup = (): void => {
      input.remove()
      window.removeEventListener('focus', onFocus)
    }
    const onFocus = (): void => {
      // 用户取消时部分浏览器不触发 change，用窗口重新获得焦点兜底
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

async function readImageMeta(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap !== 'function') return { width: 0, height: 0 }
  try {
    const bitmap = await createImageBitmap(blob)
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  } catch {
    return { width: 0, height: 0 }
  }
}

async function toPicked(file: File): Promise<PickedImage> {
  const meta = await readImageMeta(file)
  return {
    blob: file,
    name: file.name || `photo-${Date.now()}.jpg`,
    mimeType: file.type || 'image/jpeg',
    width: meta.width,
    height: meta.height,
  }
}

function timestampName(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `scan-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.jpg`
}

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', JPEG_QUALITY)
  })
}

export const webOcrService: OcrService = {
  driver: 'web',

  isSupported(): boolean {
    return hasDom()
  },

  isCameraSupported(): boolean {
    return (
      hasDom() &&
      window.isSecureContext === true &&
      typeof navigator !== 'undefined' &&
      navigator.mediaDevices !== undefined &&
      typeof navigator.mediaDevices.getUserMedia === 'function'
    )
  },

  async pickFromFiles(multiple: boolean): Promise<PickedImage[]> {
    const files = await pickFiles(multiple, false)
    return Promise.all(files.map((file) => toPicked(file)))
  },

  async capture(): Promise<PickedImage[]> {
    const files = await pickFiles(false, true)
    const images = await Promise.all(files.map((file) => toPicked(file)))
    return images.map((image) => ({ ...image, name: timestampName() }))
  },

  async captureLive(): Promise<PickedImage[]> {
    if (!webOcrService.isCameraSupported()) {
      throw new Error('当前环境不支持摄像头（需要 https 或 localhost）')
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    })
    const video = document.createElement('video')
    video.playsInline = true
    video.muted = true
    video.srcObject = stream

    try {
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = (): void => resolve()
        video.onerror = (): void => reject(new Error('摄像头画面加载失败'))
        void video.play().catch(() => undefined)
      })
      // 等一帧，避免拿到黑屏
      await new Promise<void>((resolve) => window.setTimeout(resolve, 300))

      const width = video.videoWidth || 1280
      const height = video.videoHeight || 720
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('无法创建画布上下文')
      ctx.drawImage(video, 0, 0, width, height)
      const blob = await canvasToBlob(canvas)
      if (!blob) throw new Error('拍摄失败：画布导出为空')
      return [{ blob, name: timestampName(), mimeType: 'image/jpeg', width, height }]
    } finally {
      for (const track of stream.getTracks()) track.stop()
      video.srcObject = null
    }
  },

  async compress(image: PickedImage, maxEdge: number = DEFAULT_MAX_EDGE): Promise<PickedImage> {
    if (typeof createImageBitmap !== 'function') return image
    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(image.blob)
    } catch {
      return image
    }
    try {
      const longest = Math.max(bitmap.width, bitmap.height)
      const scale = longest > 0 ? Math.min(1, maxEdge / longest) : 1
      const width = Math.max(1, Math.round(bitmap.width * scale))
      const height = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) return image
      ctx.drawImage(bitmap, 0, 0, width, height)
      const blob = await canvasToBlob(canvas)
      if (!blob) return image
      return {
        blob,
        name: image.name,
        mimeType: 'image/jpeg',
        width,
        height,
      }
    } finally {
      bitmap.close()
    }
  },
}

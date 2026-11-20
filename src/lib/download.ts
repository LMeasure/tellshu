/**
 * 文本文件下载（Blob + a.click）
 * ------------------------------------------------------------------
 * 字幕 / 学习稿导出用。URL 延迟 1s 回收：Safari 需要 URL 在 click 引发的
 * 下载动作之后仍然存活，立即 revoke 会静默失败。
 *
 * 格式 -> MIME：按导出类型给正确 Content-Type（CSV 给 text/csv 让表格
 * 软件直接识别、VTT 给 text/vtt、JSON 给 application/json）。
 * 失败抛错：调用方（UI）出错误态，绝不让点击静默无响应。
 */

export type DownloadFormat = 'txt' | 'srt' | 'vtt' | 'csv' | 'json'

const MIME_BY_FORMAT: Record<DownloadFormat, string> = {
  txt: 'text/plain;charset=utf-8',
  srt: 'application/x-subrip;charset=utf-8',
  vtt: 'text/vtt;charset=utf-8',
  csv: 'text/csv;charset=utf-8',
  json: 'application/json;charset=utf-8',
}

/** 触发浏览器下载一个文本文件；失败抛 Error（供 UI 显示错误态）。 */
export function downloadTextFile(
  fileName: string,
  text: string,
  format: DownloadFormat = 'txt',
): void {
  const name = fileName.trim() === '' ? `export.${format}` : fileName
  try {
    const blob = new Blob([text], { type: MIME_BY_FORMAT[format] })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  } catch (error) {
    throw new Error(
      `下载失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

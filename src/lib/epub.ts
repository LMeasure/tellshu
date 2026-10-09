/**
 * EPUB 文本提取（纯前端，jszip 解包 + 轻量解析）
 * ------------------------------------------------------------------
 * 书籍导入仅做 TXT + EPUB 真可读（见计划）：本模块把 EPUB 解包为纯文本，
 * 复用增强阅读器（点词加生词本 + 记忆模式）。
 *
 * 流程：container.xml → OPF 路径 → manifest(id→href) + spine(顺序)
 *      → 按 spine 顺序读取 xhtml → 去标签提取文本 → 合并。
 * 排版/图片 alt 可能混入少量噪音，属真实内容，不伪造。
 */

import JSZip from 'jszip'

/** 把一段 XHTML/HTML 剥离标签为纯文本（正则，浏览器/Node 均可） */
export function htmlToText(html: string): string {
  if (!html) return ''
  let s = html
  // 去除脚本/样式
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  // 块级元素前插换行
  s = s.replace(/<\s*(p|div|br|h[1-6]|li|tr|section|blockquote)[^>]*>/gi, '\n')
  s = s.replace(/<\s*\/\s*(p|div|h[1-6]|li|tr|section|blockquote)[^>]*>/gi, '\n')
  // 去除剩余标签
  s = s.replace(/<[^>]+>/g, ' ')
  // 常见实体解码
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
  // 压缩空白，保留段落换行
  s = s.replace(/[ \t]+/g, ' ').replace(/ /g, ' ')
  s = s.replace(/\n[ \t]+/g, '\n').replace(/[ \t]+\n/g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n').trim()
  return s
}

function resolvePath(base: string, relative: string): string {
  const baseParts = base.split('/').slice(0, -1)
  for (const part of relative.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') baseParts.pop()
    else baseParts.push(part)
  }
  return baseParts.join('/')
}

/** 章节条目：标题 + 起始段落下标（对应 content 按 /\n+/ 切分后的段序） */
export interface BookChapter {
  title: string
  /** 该章第一段在全文章节数组中的下标（用于目录跳转，无字符偏移误差） */
  para: number
}

/** 解析结果：全文 + 章节目录 */
export interface ParsedBook {
  content: string
  chapters: BookChapter[]
}

/** 提取 EPUB 纯文本（兼容旧调用）；失败抛错（调用方负责降级提示）。 */
export async function extractEpubText(file: File | ArrayBuffer): Promise<string> {
  return (await extractEpubBook(file)).content
}

/**
 * 提取 EPUB 全文 **并保留章节目录**。
 * 目录来源优先级：
 *   1. EPUB3 导航文档（manifest 中 properties 含 nav）
 *   2. EPUB2 NCX（spine[toc] 指向的 .ncx）
 *   3. 都取不到 → 按 spine 顺序生成「第 N 节」占位标题（结构真实，不虚构内容）
 * 章节正文顺序始终以 spine 为准，标题只是附加信息。
 */
export async function extractEpubBook(file: File | ArrayBuffer): Promise<ParsedBook> {
  const zip = await JSZip.loadAsync(file as any)
  const containerFile = zip.file('META-INF/container.xml')
  if (!containerFile) throw new Error('缺少 META-INF/container.xml')
  const containerXml = await containerFile.async('text')
  const opfPath = parseOpfPath(containerXml)
  if (!opfPath) throw new Error('无法解析 OPF 路径')

  const opfFile = zip.file(opfPath)
  if (!opfFile) throw new Error('OPF 文件缺失')
  const opfXml = await opfFile.async('text')

  const { manifest, spine, navHref, ncxHref } = parseOpf(opfXml)
  if (spine.length === 0) throw new Error('OPF 未声明 spine')

  // 1) 目录：先试 EPUB3 nav，再试 NCX
  const tocTitles = await loadTocTitles(zip, opfPath, navHref, ncxHref)

  const chapters: BookChapter[] = []
  const parts: string[] = []
  let paraCursor = 0
  for (const id of spine) {
    const href = manifest[id]
    if (!href) continue
    const full = resolvePath(opfPath, href)
    const xhtml = zip.file(full)
    if (!xhtml) continue
    const text = htmlToText(await xhtml.async('text'))
    if (!text) continue

    const paras = text.split(/\n+/).filter(Boolean)
    if (paras.length === 0) continue

    // 标题：TOC 里指向本文件的条目优先，否则用「第 N 节」
    const title =
      tocTitles.get(stripFragment(full)) ||
      tocTitles.get(stripFragment(full).split('/').pop() || '') ||
      `第 ${chapters.length + 1} 节`

    chapters.push({ title, para: paraCursor })
    parts.push(text)
    paraCursor += paras.length
  }

  const content = parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!content) throw new Error('EPUB 未提取到可读文本')
  return { content, chapters }
}

/** 读取目录标题：key 为去 fragment 的资源路径（或文件名），value 为标题 */
async function loadTocTitles(
  zip: JSZip,
  opfPath: string,
  navHref: string | undefined,
  ncxHref: string | undefined,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()

  // EPUB3 nav
  if (navHref) {
    const f = zip.file(resolvePath(opfPath, navHref))
    if (f) {
      const html = await f.async('text')
      collectAnchorTitles(html, (href, title) => {
        if (!title) return
        const full = resolvePath(resolvePath(opfPath, navHref), href)
        const key = stripFragment(full)
        if (!out.has(key)) out.set(key, title)
        const base = key.split('/').pop()
        if (base && !out.has(base)) out.set(base, title)
      })
    }
  }

  // EPUB2 NCX
  if (out.size === 0 && ncxHref) {
    const f = zip.file(resolvePath(opfPath, ncxHref))
    if (f) {
      const xml = await f.async('text')
      const doc = new DOMParser().parseFromString(xml, 'application/xml')
      doc.querySelectorAll('navPoint').forEach((np) => {
        const title = np.querySelector('navLabel > text')?.textContent?.trim()
        const src = np.querySelector('content')?.getAttribute('src')
        if (!title || !src) return
        const key = stripFragment(resolvePath(resolvePath(opfPath, ncxHref), src))
        if (!out.has(key)) out.set(key, title)
        const base = key.split('/').pop()
        if (base && !out.has(base)) out.set(base, title)
      })
    }
  }
  return out
}

/** 从 nav 文档收集 <a href> 的标题（取链接内文本，忽略纯锚点跳转） */
function collectAnchorTitles(html: string, cb: (href: string, title: string) => void) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('nav a[href], a[href]').forEach((a) => {
    const href = a.getAttribute('href') || ''
    if (!href || href.startsWith('http') || href.startsWith('#')) return
    const title = (a.textContent || '').replace(/\s+/g, ' ').trim()
    if (title) cb(href, title)
  })
}

function stripFragment(p: string): string {
  return p.split('#')[0]
}

/** 解析 container.xml 找 OPF 全路径 */
function parseOpfPath(xml: string): string | null {
  const m = xml.match(/full-path="([^"]+)"/)
  return m ? m[1] : null
}

/** 解析 OPF：manifest(id→href) + spine(有序 id 列表) + 导航文档/NCX 位置 */
function parseOpf(xml: string): {
  manifest: Record<string, string>
  spine: string[]
  navHref?: string
  ncxHref?: string
} {
  const manifest: Record<string, string> = {}
  const spine: string[] = []
  let navHref: string | undefined
  let ncxHref: string | undefined
  const parser = new DOMParser()
  const doc = parser.parseFromString(xml, 'application/xml')
  doc.querySelectorAll('manifest > item').forEach((item) => {
    const id = item.getAttribute('id')
    const href = item.getAttribute('href')
    const mt = (item.getAttribute('media-type') || '').toLowerCase()
    const props = (item.getAttribute('properties') || '').toLowerCase()
    if (!href) return
    // EPUB3 导航文档
    if (props.split(/\s+/).includes('nav')) navHref = href
    // EPUB2 NCX
    if (mt.includes('dtbncx')) ncxHref = href
    if (id && (mt.includes('html') || mt.includes('xhtml') || mt === '')) {
      manifest[id] = href
    }
  })
  doc.querySelectorAll('spine > itemref').forEach((ref) => {
    const idref = ref.getAttribute('idref')
    if (idref && manifest[idref]) spine.push(idref)
  })
  // spine 上的 toc 属性指向 NCX（EPUB2 常见写法）
  const tocId = doc.querySelector('spine')?.getAttribute('toc')
  if (tocId && manifest[tocId]) ncxHref = ncxHref ?? manifest[tocId]
  // 若 spine 为空但 manifest 有 html，兜底按 manifest 顺序
  if (spine.length === 0) spine.push(...Object.keys(manifest))
  return { manifest, spine, navHref, ncxHref }
}

/* ------------------------------------------------------------------
 * TXT：按常见章节标记切章（找不到标记则整本作为一章，不硬造目录）
 * ------------------------------------------------------------------ */

const CHAPTER_RE =
  /^\s*(?:chapter|part|unit|lesson|book|section)\s+([0-9]+|[ivxlcdm]+)\b.*$|^\s*第\s*[0-9一二三四五六七八九十百零]+\s*[章节回卷篇].*$/i

/** 把纯文本按章节标记切分为「全文 + 目录」 */
export function parseTxtBook(text: string): ParsedBook {
  const paragraphs = text.split(/\n+/).map((s) => s.trim()).filter(Boolean)
  const chapters: BookChapter[] = []
  paragraphs.forEach((p, i) => {
    // 标题行通常很短，避免把正文里恰好以 chapter 开头的长句当标题
    if (p.length <= 60 && CHAPTER_RE.test(p)) {
      chapters.push({ title: p, para: i })
    }
  })
  return {
    content: paragraphs.join('\n\n'),
    // 一章都没识别到 → 不虚构目录，交由阅读器按整本处理
    chapters: chapters.length >= 2 ? chapters : [],
  }
}

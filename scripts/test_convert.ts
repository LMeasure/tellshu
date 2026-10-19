/**
 * 格式转换·纯逻辑单测
 * 运行：npx tsx scripts/test_convert.ts
 * 覆盖：格式识别（扩展名/MIME/综合）、目标候选、组合合法性、常量。
 */
import {
  ACCEPT_ATTR,
  ALLOWED_CONVERSIONS,
  FORMAT_LABEL,
  detectFormat,
  detectFormatFromName,
  isAllowedConversion,
  isSupportedSource,
  targetCandidates,
  type ConvertFormat,
} from '../src/domain/convert'

let failed = 0
function assert(cond: boolean, msg: string): void {
  if (cond) console.log('  ✓', msg)
  else {
    console.error('  ✗', msg)
    failed += 1
  }
}
function eq<T>(actual: T, expected: T, msg: string): void {
  assert(
    actual === expected,
    `${msg}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`,
  )
}

function main(): void {
  console.log('[格式识别] 扩展名识别')
  eq(detectFormatFromName('a.PDF'), 'pdf', 'pdf 大小写不敏感')
  eq(detectFormatFromName('报告.docx'), 'docx', 'docx 中文名')
  eq(detectFormatFromName('pic.PNG'), 'png', 'png')
  eq(detectFormatFromName('pic.JPEG'), 'jpg', 'jpeg 归并到 jpg')
  eq(detectFormatFromName('表.xlsx'), 'xlsx', 'xlsx')
  eq(detectFormatFromName('noext'), null, '无扩展名返回 null（不臆造）')
  eq(detectFormatFromName('a.txt'), null, '不支持的格式返回 null')

  console.log('[格式识别] MIME 回退')
  eq(detectFormat('weird', 'application/pdf'), 'pdf', 'MIME 兜底 pdf')
  eq(detectFormat('weird', 'image/png'), 'png', 'MIME 兜底 png')
  eq(detectFormat('a.pdf', 'application/pdf'), 'pdf', '扩展名优先于 MIME')
  eq(detectFormat('weird', 'application/unknown'), null, '无匹配返回 null')

  console.log('[目标候选] 仅返回白名单组合')
  eq(JSON.stringify(targetCandidates('pdf')), JSON.stringify(['docx', 'png']), 'pdf 候选为 docx/png')
  eq(JSON.stringify(targetCandidates('jpg')), JSON.stringify(['pdf']), 'jpg 候选为 pdf')
  eq(JSON.stringify(targetCandidates('xlsx')), JSON.stringify(['pdf']), 'xlsx 候选为 pdf')
  eq(targetCandidates('docx' as ConvertFormat).length, 1, 'docx 仅 1 候选')

  console.log('[合法性] 组合校验')
  assert(isAllowedConversion('pdf', 'docx'), 'pdf→docx 合法')
  assert(isAllowedConversion('docx', 'pdf'), 'docx→pdf 合法')
  assert(!isAllowedConversion('pdf', 'pdf'), '同格式不合法')
  assert(!isAllowedConversion('pdf', 'xlsx'), 'pdf→xlsx 不在白名单')
  assert(isSupportedSource('pdf'), 'pdf 是合法源')
  assert(!isSupportedSource('txt' as ConvertFormat), 'txt 不是合法源')

  console.log('[常量] 标签与 accept')
  eq(FORMAT_LABEL.pdf, 'PDF', 'pdf 标签')
  assert(ACCEPT_ATTR.includes('.docx'), 'accept 含 docx')
  eq(ALLOWED_CONVERSIONS.length, 6, 'V1 共 6 条白名单组合')

  if (failed) {
    console.error(`\n${failed} 项失败`)
    process.exit(1)
  }
  console.log('\n格式转换纯逻辑单测全部通过 ✓')
}

main()

import { useEffect, useState } from 'react'
import { ShieldCheck, ExternalLink, Database } from 'lucide-react'
import { Card, CardBody } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { repository, type SourceAttribution } from '@/data/repository'

/**
 * 词库来源与 CC BY-SA 4.0 署名
 * ------------------------------------------------------------------
 * 硬约束：OpenEtymology 词库为 CC BY-SA 4.0，必须署名并声明「衍生作品采用相同协议」。
 * 所有字段（来源 / 署名 / 协议 / 词数）均由数据管线写入 index.json，此处只做渲染，
 * **不在代码里硬编码任何版权文案**，换数据源时署名自动跟随，不会出现张冠李戴。
 * 取不到索引时不渲染（而不是渲染一份写死的免责声明）。
 */
export function SourceAttribution() {
  const [info, setInfo] = useState<SourceAttribution | null>(null)

  useEffect(() => {
    repository.getAttribution().then(setInfo)
  }, [])

  if (!info) return null

  const date = info.generated_at ? info.generated_at.slice(0, 10) : ''

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-center gap-2 text-base font-semibold">
          <ShieldCheck className="h-5 w-5 text-primary" /> 数据来源与授权
        </div>

        <div className="space-y-1.5 text-sm">
          <div className="text-muted-foreground">内容来源</div>
          <div>{info.source}</div>
        </div>

        <div className="space-y-1.5 text-sm">
          <div className="text-muted-foreground">署名</div>
          <div>{info.attribution}</div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge className="bg-primary/10 text-primary">{info.license}</Badge>
          <Badge>
            <Database className="mr-1 h-3 w-3" />
            {info.total.toLocaleString('zh-CN')} 词
          </Badge>
          {date && <Badge>数据版本 {date}</Badge>}
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">
          本应用中的词库内容衍生自上述作品；依据 CC BY-SA 4.0（署名—相同方式共享）协议，
          本衍生作品亦采用相同协议共享。
        </p>

        {info.books.length > 0 && (
          <div className="border-t border-border pt-3">
            <div className="mb-2 text-xs text-muted-foreground">收录词本</div>
            <div className="flex flex-wrap gap-1.5">
              {info.books.map((b) => (
                <span
                  key={b.id}
                  className="rounded-md bg-secondary px-2 py-1 text-xs text-secondary-foreground"
                >
                  {b.name} · {b.count.toLocaleString('zh-CN')}
                </span>
              ))}
            </div>
          </div>
        )}

        <a
          href="https://creativecommons.org/licenses/by-sa/4.0/"
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-xs text-primary"
        >
          查看协议全文 <ExternalLink className="h-3 w-3" />
        </a>
      </CardBody>
    </Card>
  )
}

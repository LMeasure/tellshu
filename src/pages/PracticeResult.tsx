import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle2, Trophy, PartyPopper, X } from 'lucide-react'
import { Card, CardBody } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

/**
 * 成就弹窗（见 04 §2.5 / 06 §8.1 去重规则）：
 *  - 当日完成度 ≥80% → 每日 1 次祝贺弹窗
 *  - 连续天数里程碑 3/7/14/30 → 专属徽章弹窗
 *  - 同日多成就：里程碑 > 完成度，合并为 1 张卡片，仅弹 1 次
 *  - 单卡/单练完成：仅音效+微动效，不弹窗
 *  - 3 秒无操作或点「收下」自动关闭
 */
function AchievementPopup() {
  const [open, setOpen] = useState(true)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 px-8">
      <div className="w-full max-w-[320px] rounded-2xl bg-card p-5 text-center shadow-soft">
        <button
          onClick={() => setOpen(false)}
          className="absolute right-3 top-3 text-muted-foreground"
          aria-label="关闭"
        >
          <X className="h-5 w-5" />
        </button>
        <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-accent/15 text-accent">
          <Trophy className="h-8 w-8" />
        </div>
        <p className="text-lg font-bold">连续学习 7 天！</p>
        <div className="my-2 h-px bg-border" />
        <p className="text-sm text-muted-foreground">太棒了！今日任务也快完成啦 🎉</p>
        <Button variant="accent" className="mt-4 w-full" onClick={() => setOpen(false)}>
          收下
        </Button>
      </div>
    </div>
  )
}

/** 练习结果（见 04 §2.5、05 §2.5）：对错统计 + 成就弹窗 */
export function PracticeResult() {
  const navigate = useNavigate()
  const [showPopup] = useState(true)

  return (
    <div className="flex min-h-screen flex-col px-4 py-6">
      <div className="mb-4 flex flex-col items-center gap-2">
        <CheckCircle2 className="h-12 w-12 text-primary" />
        <h2 className="text-xl font-bold">练习完成</h2>
      </div>

      <Card className="mb-4">
        <CardBody className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">答对</span>
            <span className="font-semibold">— / —</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">今日任务完成度</span>
            <span className="font-semibold">0%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">连续天数</span>
            <span className="font-semibold">0 天</span>
          </div>
        </CardBody>
      </Card>

      <p className="mb-3 flex items-center gap-1 text-xs text-muted-foreground">
        <PartyPopper className="h-3.5 w-3.5" /> 真实成绩将在接入学习数据与分层掌握后计算（Phase 1）。
      </p>

      <div className="mt-auto space-y-2">
        <Button variant="secondary" className="w-full" onClick={() => navigate('/review')}>
          去复习
        </Button>
        <Button className="w-full" onClick={() => navigate('/')}>
          回到首页
        </Button>
      </div>

      {showPopup && <AchievementPopup />}
    </div>
  )
}

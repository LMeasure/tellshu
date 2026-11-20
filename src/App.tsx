import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/components/layout/AppShell'
import { useAppStore } from '@/store/useAppStore'
import { StartLogin } from '@/pages/StartLogin'
import { Diagnosis } from '@/pages/Diagnosis'
import { Home } from '@/pages/Home'
import { Search } from '@/pages/Search'
import { LearningPath } from '@/pages/LearningPath'
import { LearningFlow } from '@/pages/LearningFlow'
import { ChallengeScreen } from '@/pages/ChallengeScreen'
import { PracticeResult } from '@/pages/PracticeResult'
import { Discover } from '@/pages/Discover'
import { CourseDetail } from '@/pages/CourseDetail'
import { Review } from '@/pages/Review'
import { Spelling } from '@/pages/Spelling'
import { SpellingResult } from '@/pages/SpellingResult'
import { Profile } from '@/pages/Profile'
import { Settings } from '@/pages/Settings'
import { Import } from '@/pages/Import'
import { Reader } from '@/pages/Reader'
import { Collections } from '@/pages/Collections'
import { CollectionDetail } from '@/pages/CollectionDetail'
import { Recitations } from '@/pages/Recitations'
import { WordBank } from '@/pages/WordBank'
import { WordDetail } from '@/pages/WordDetail'
import { DictIngest } from '@/pages/DictIngest'

export default function App() {
  const darkMode = useAppStore((s) => s.settings.darkMode)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
  }, [darkMode])

  return (
    <Routes>
      {/* 前置门：启动 / 登录（Phase 0 mock 游客） */}
      <Route path="/start" element={<StartLogin />} />
      <Route path="/diagnosis" element={<Diagnosis />} />

      {/* 主 App：带外壳的 4 个 Tab + 子页 */}
      <Route
        path="/"
        element={
          <AppShell>
            <Home />
          </AppShell>
        }
      />
      <Route
        path="/search"
        element={
          /* /search 自身就是搜索页：不挂全局搜索停靠，避免同功能重复 */
          <AppShell showGlobalSearch={false}>
            <Search />
          </AppShell>
        }
      />
      <Route
        path="/path"
        element={
          <AppShell>
            <LearningPath />
          </AppShell>
        }
      />
      <Route
        path="/learn"
        element={
          /* 单词学习页：底部不挂全局搜索（用户 2026-10-31 定稿），
             只影响本页 —— /search 与其它页面的全局搜索照旧 */
          <AppShell showGlobalSearch={false}>
            <LearningFlow />
          </AppShell>
        }
      />
      <Route
        path="/challenge"
        element={
          <AppShell>
            <ChallengeScreen />
          </AppShell>
        }
      />
      <Route
        path="/result"
        element={
          <AppShell>
            <PracticeResult />
          </AppShell>
        }
      />
      <Route
        path="/discover"
        element={
          <AppShell>
            <Discover />
          </AppShell>
        }
      />
      <Route
        path="/course/:id"
        element={
          <AppShell>
            <CourseDetail />
          </AppShell>
        }
      />
      <Route
        path="/review"
        element={
          <AppShell>
            <Review />
          </AppShell>
        }
      />
      {/* 单词默写：练习页与结果页（2026-10-21，方案 V3.2 §7）。
          结果页是独立路由，不复用占位的 /result */}
      <Route
        path="/spelling"
        element={
          <AppShell>
            <Spelling />
          </AppShell>
        }
      />
      <Route
        path="/spelling-result"
        element={
          <AppShell>
            <SpellingResult />
          </AppShell>
        }
      />
      <Route
        path="/profile"
        element={
          <AppShell>
            <Profile />
          </AppShell>
        }
      />
      <Route
        path="/collections"
        element={
          <AppShell>
            <Collections />
          </AppShell>
        }
      />
      <Route
        path="/collection/:id"
        element={
          <AppShell>
            <CollectionDetail />
          </AppShell>
        }
      />
      <Route
        path="/settings"
        element={
          <AppShell>
            <Settings />
          </AppShell>
        }
      />
      <Route
        path="/import"
        element={
          <AppShell>
            <Import />
          </AppShell>
        }
      />
      {/* 阅读器：全屏沉浸（2026-10-07 起不再套 AppShell —— 沉浸式阅读没有底部 Tab） */}
      <Route path="/reader/:id" element={<Reader />} />
      <Route
        path="/recitations"
        element={
          <AppShell>
            <Recitations />
          </AppShell>
        }
      />

      {/* 单词详情页：自带青绿渐变吸顶头，不用 AppShell 的顶部搜索栏 */}
      <Route path="/word/:word" element={<WordDetail />} />

      {/* 全量词库：主题（一级）+ 难度（二级） */}
      <Route
        path="/bank/:kind/:key"
        element={
          <AppShell>
            <WordBank />
          </AppShell>
        }
      />

      {/* 词典扫描库：功能 B 的权限入口（管理员口令在页内解锁） */}
      <Route
        path="/dict-ingest"
        element={
          <AppShell>
            <DictIngest />
          </AppShell>
        }
      />

      <Route path="*" element={<Navigate to="/start" replace />} />
    </Routes>
  )
}

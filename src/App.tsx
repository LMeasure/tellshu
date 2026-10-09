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
          <AppShell>
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
          <AppShell showTopSearch={false}>
            <LearningFlow />
          </AppShell>
        }
      />
      <Route
        path="/challenge"
        element={
          <AppShell showTopSearch={false}>
            <ChallengeScreen />
          </AppShell>
        }
      />
      <Route
        path="/result"
        element={
          <AppShell showTopSearch={false}>
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
          <AppShell showTopSearch={false}>
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
          <AppShell showTopSearch={false}>
            <DictIngest />
          </AppShell>
        }
      />

      <Route path="*" element={<Navigate to="/start" replace />} />
    </Routes>
  )
}

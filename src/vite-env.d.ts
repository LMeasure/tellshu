/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * 词库数据基址，末尾需带 `/`。
   * 留空则回退到同源 `${BASE_URL}data/linguabase/v1/`（由 vite 中间件直出本地 data/）。
   * 生产示例：https://data.shushu.app/linguabase/v1/
   */
  readonly VITE_DATA_BASE_URL?: string

  /**
   * 数据版本目录名，默认 `v1`。数据路径形如 `<base>data/linguabase/<版本>/`。
   * 发新版数据：上传 `linguabase/v2/` 后把此值改成 `v2` 重新部署，
   * 老客户端继续读 v1，可灰度可回滚。改它需要重新构建。
   */
  readonly VITE_DATA_VERSION?: string
}

interface Window {
  /** 运行期覆盖数据基址（不重新构建即可换数据源），见 src/data/dataClient.ts */
  __SHUSHU_DATA_BASE__?: string
}

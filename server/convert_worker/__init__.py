"""格式转换 Worker 包。

复用 server/ 的 Postgres 连接与 convert_tasks / convert_files 两张表，
轮询 waiting 任务 -> 调 Converter 插件 -> 落结果文件 -> 写回状态。

与 格式转换.md 的差异（刻意收敛）：
    spec 建议 Redis/Celery 队列；本项目已有 pg 任务表与连接池，
    故 Worker 直接轮询 pg（UPDATE...RETURNING 原子认领），不引入新依赖。
"""

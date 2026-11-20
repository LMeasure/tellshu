# 找书功能 · VPS 一体化部署 Runbook

> 承接《找书功能-生产部署前置方案.md》（commit 50bd55a）§2 推荐路径。
> 目标：一台 2C4G 云服务器（Debian 12 / Ubuntu 24.04）同机运行 **PG18 + pgvector** 与**检索 API**，Caddy 自动 TLS 对外，Vercel 同源反代 `/api/discover`。
> 执行者：你（需 root 或 sudo）。每一步都有验收命令，绿了再下一步。

---

## 0. 前置条件（外部输入，Runbook 无法自取）

| 项 | 要求 | 状态 |
|---|---|---|
| 云服务器 | 2C4G / 40G SSD / 公网 IP / Debian 或 Ubuntu | 待提供 |
| 域名 | 一个你可控解析的域，为 API 分配子域（如 `discover-api.<你的域>` A 记录 → 服务器 IP） | 待提供 |
| SSH | root 或 sudo 用户 | 待提供 |
| Vercel 项目 | 已有（找书 Tab 已在前端产物中） | 已有 |

> 说明：本文所有命令中的 `<SERVER_IP>`、`<API_DOMAIN>` 在拿到上述信息后替换。**没有域名也能先完成 §1~§4**（用 IP + 自签或先只验证内网），§5 起需要域名。

---

## 1. 服务器基础与防火墙

```bash
# 系统更新
apt update && apt upgrade -y

# 只放 22(SSH)/80/443；8000 与 5432 不对外
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw enable

# 时区与时间同步（uvicorn 日志时序依赖）
timedatectl set-timezone Asia/Shanghai
```

验收：`ufw status numbered` 只有 22/80/443。

## 2. PG18 + pgvector 安装与数据迁移

```bash
# PG 官方 APT 源（以 Debian 12 为例；Ubuntu 24.04 换对应代号）
apt install -y postgresql-common
/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
apt install -y postgresql-18 postgresql-18-pgvector

# 在原机器（述树项目机）导出——1.3GB，几分钟
pg_dump -Fc -h 127.0.0.1 -U postgres shutree > shutree.pgdump
scp shutree.pgdump root@<SERVER_IP>:/root/

# 服务器上恢复
sudo -u postgres createdb shutree
sudo -u postgres pg_restore -d shutree --no-owner /root/shutree.pgdump
```

PG 参数（B.12 结论照搬，**这是 8ms 检索口径的前提**）：

```bash
# /etc/postgresql/18/main/postgresql.conf
shared_buffers = 2GB
effective_cache_size = 8GB

sudo systemctl restart postgresql
```

连接准备（API 以专用角色连接，口令只进环境文件不进仓库）：

```bash
sudo -u postgres psql -c "CREATE ROLE discover LOGIN PASSWORD '换成强随机串';"
sudo -u postgres psql -d shutree -c "GRANT CONNECT ON DATABASE shutree TO discover; GRANT USAGE ON SCHEMA public TO discover; GRANT SELECT ON ALL TABLES IN SCHEMA public TO discover;"
```

验收：`sudo -u postgres psql -d shutree -c "SELECT count(*) FROM discovered_books;"` → 30。

## 3. 检索 API 部署

```bash
# 代码与模型（模型 543MB，从原机器传）
useradd -r -m -s /bin/bash shutree
rsync -a api/ shutree@<SERVER_IP>:/home/shutree/api/     # 不含模型
rsync -a bge-m3-onnx/ shutree@<SERVER_IP>:/home/shutree/bge-m3-onnx/  # 543MB

# Python 环境（API 实测跑在 3.14；服务器建议 3.12，依赖见 requirements-api.txt）
apt install -y python3.12-venv
sudo -u shutree python3.12 -m venv /home/shutree/venv
sudo -u shutree /home/shutree/venv/bin/pip install -r /home/shutree/api/requirements-api.txt
```

环境文件（`chmod 600`，只有 root 与 shutree 可读；**密钥只在此处，不进仓库**）：

```bash
# /etc/shutree-discover.env
EMBEDDING_BACKEND=onnx
HF_HUB_OFFLINE=1
DATABASE_URL=postgresql://discover:<强随机串>@127.0.0.1:5432/shutree
```

> 注意：`api/config.py` 若从 `.env` 读连接串，把文件放 `api/.env` 或确认 systemd `EnvironmentFile` 生效路径与 config 一致——上线前用 `sudo -u shutree env $(grep -v '^#' /etc/shutree-discover.env | xargs) /home/shutree/venv/bin/python -c "from config import load; print(load().database_url.startswith('postgresql://discover:'))"` 自检（打印 True 再继续）。

systemd unit：

```ini
# /etc/systemd/system/shutree-discover.service
[Unit]
Description=ShuTree Discover Search API
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=shutree
WorkingDirectory=/home/shutree/api
EnvironmentFile=/etc/shutree-discover.env
ExecStart=/home/shutree/venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now shutree-discover
```

验收：`curl -s http://127.0.0.1:8000/api/discover/health` → 200 JSON；`systemctl status shutree-discover` 无重启循环。

## 4. Caddy 自动 TLS

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
# 官方一键装（见 caddyserver.com 当前指令）
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

```caddyfile
# /etc/caddy/Caddyfile
<API_DOMAIN> {
    reverse_proxy 127.0.0.1:8000
}
```

```bash
systemctl reload caddy
```

验收：`curl -s https://<API_DOMAIN>/api/discover/health` → 200（证书自动签发，DNS 生效通常 1 分钟内）。**这一步 OK 就说明 §2/§3 全链路通了。**

## 5. Vercel 生产路由（`vercel.json`，第 3 步落地）

把仓库 `vercel.json` 的 `rewrites` 改为（**数组头部插入，必须在 catch-all 之前**）：

```json
"rewrites": [
  { "source": "/api/discover/:path*", "destination": "https://<API_DOMAIN>/api/discover/:path*" },
  { "source": "/(.*)", "destination": "/index.html" }
]
```

提交后 Vercel 自动部署。前端 `discoverClient` 零改动（仍走同源 `/api/discover`）。

## 6. 部署后验收（第 4 步）

```bash
# 1) 路由优先级：返回 JSON 而非 index.html
curl -sX POST https://<你的前端域>/api/discover \
  -H 'Content-Type: application/json' \
  -d '{"query":"crime and punishment","top_k":3}' | head -c 400

# 2) 浏览器真实检索场景（39 项中的真实路径全量复跑）
BROWSER_ACCEPT_BASE=https://<你的前端域> npm run check:book-browser real
```

预期：`results` 数组含《Crime and Punishment》等命中；`meta.returned` 与实际一致。若返回 HTML → 检查 rewrites 数组顺序（`/api/discover` 是否被 catch-all 抢先）。

## 7. 上线后维护

| 事项 | 做法 |
|---|---|
| 模型/代码更新 | `rsync` 新文件后 `systemctl restart shutree-discover` |
| PG 备份 | `pg_dump -Fc` 每日 cron，保留 7 份（库 1.3GB，pick 一台对象存储或本机第二盘） |
| 指标 | Caddy access log + `GET /api/discover/health` 外部探活（UptimeRobot 免费档即可） |
| retrieve 变慢 | 先查服务器 `shared_buffers` 是否 2GB、连接池是否被长查询占满（对照 B.12 口径：先看内存状态再比数字） |
| 证书 | Caddy 自动续期，无操作 |

## 8. 回滚

`vercel.json` rewrites 删掉第一条即回到当前状态（`/api/discover` 返回 SPA 页面→前端显示「响应不是 JSON」错误态，功能可观测地关闭但不白屏）。服务器侧 `systemctl stop shutree-discover` 不影响其他任何服务。

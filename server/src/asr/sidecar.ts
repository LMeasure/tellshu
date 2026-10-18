// =============================================================================
// 本地 ASR sidecar 进程管理：spawn -> health 门控 -> 死亡标记 -> 关闭
// -----------------------------------------------------------------------------
// Phase 1.5 修订版 §3.5：Node 启动时 spawn Python sidecar（模型常驻），
// /health 就绪后才放行 submit；sidecar 未就绪 / 死亡 -> 提交 503「不可用」，
// 不排队假任务；不自动重启（防崩溃循环），重启 Node 即恢复。
//
// 可测性：spawnImpl / fetchImpl 可注入（单测用假子进程 + 假 fetch，
// 不起真实 Python）；纯逻辑（命令行构造 / 状态机 / 超时）全部有断言。
// =============================================================================

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { AsrProviderConfig } from '../config';
import { SERVER_ROOT } from '../config';
import { AsrProviderError } from './providerError';

/** sidecar 服务目录（编译后 SERVER_ROOT 仍指向 server/）。 */
export const ASR_SERVICE_DIR = path.resolve(SERVER_ROOT, 'asr_service');

const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_PROBE_TIMEOUT_MS = 2_000;
const HEALTH_PATH = '/health';

export type SidecarState = 'starting' | 'ready' | 'dead';

export interface SidecarSpawnRequest {
  command: string;
  args: string[];
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
    stdio: ['ignore', 'pipe', 'pipe'];
  };
}

/** 纯函数：按配置构造 sidecar 启动命令（单测主战场）。 */
export function buildSidecarSpawn(config: AsrProviderConfig): SidecarSpawnRequest {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.ASR_PORT = String(config.sidecarPort);
  env.ASR_PRELOAD_MODEL = 'true';
  // 模型目录：显式配置优先；未配置则不注入，由 sidecar 自己的默认值
  // （server/data/asr-models/whisper-small）兜底
  if (config.modelDir !== null) env.ASR_MODEL_DIR = config.modelDir;
  // 结果落盘目录与 Node 的 in/ 目录同根（data/asr/{in,out}），两侧对账用
  env.ASR_OUT_DIR = path.join(config.dataDir, 'out');
  return {
    command: config.pythonPath ?? 'python',
    args: ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(config.sidecarPort)],
    options: {
      cwd: ASR_SERVICE_DIR,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  };
}

export interface SidecarDeps {
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
  nowImpl?: () => number;
  sleepImpl?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * sidecar 子进程句柄。start() 幂等；状态机 starting -> ready | dead。
 * dead 是终态（不自动重启）：后续所有提交得到 503，重启 Node 才恢复。
 */
export class SidecarProcess {
  readonly baseUrl: string;

  private readonly config: AsrProviderConfig;
  private readonly spawnImpl: typeof spawn;
  private readonly fetchImpl: typeof fetch;
  private readonly nowImpl: () => number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  private child: ChildProcess | null = null;
  private state: SidecarState = 'starting';
  private deadReason: string | null = null;
  private exited = false;
  private readyPromise: Promise<void>;
  private resolveReady: (() => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;

  constructor(config: AsrProviderConfig, deps: SidecarDeps = {}) {
    this.config = config;
    this.spawnImpl = deps.spawnImpl ?? spawn;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.nowImpl = deps.nowImpl ?? (() => Date.now());
    this.sleepImpl = deps.sleepImpl ?? defaultSleep;
    this.baseUrl = `http://127.0.0.1:${config.sidecarPort}`;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // 就绪前无人 waitReady 时 boot 失败也会拒绝它——挂一个空 catch 防
    // unhandledRejection（Node 15+ 未处理拒绝默认致命）；
    // waitReady 侧由 Promise.race 正常接住这个拒绝
    this.readyPromise.catch(() => undefined);
  }

  getState(): SidecarState {
    return this.state;
  }

  /** spawn 子进程并开始 health 轮询（幂等；不抛错，失败进 dead 状态）。 */
  start(): void {
    if (this.state !== 'starting' || this.child !== null) return;
    void this._boot();
  }

  /** 等待 sidecar 就绪；dead / 超时 -> reject(AsrProviderError('unavailable'))。 */
  async waitReady(timeoutMs?: number): Promise<void> {
    if (this.state === 'ready') return;
    if (this.state === 'dead') {
      throw new AsrProviderError('unavailable', this.deadReason ?? '转录服务不可用');
    }
    const race: Promise<void> = timeoutMs === undefined
      ? this.readyPromise
      : Promise.race([
          this.readyPromise,
          this.sleepImpl(timeoutMs).then(() => {
            throw new AsrProviderError('unavailable', '转录服务初始化超时，请稍后重试');
          }),
        ]);
    return race;
  }

  /** 关闭子进程（Node 退出时调用；幂等）。 */
  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    // 已退出（外部 kill / 启动失败）则无需再 kill
    if (child === null || this.exited) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
        resolve();
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  // ---- 内部 ----

  private async _boot(): Promise<void> {
    const request = buildSidecarSpawn(this.config);
    try {
      const child = this.spawnImpl(request.command, request.args, request.options);
      this.child = child;
      child.stdout?.on('data', (chunk: Buffer) => this._forwardLog('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => this._forwardLog('stderr', chunk));
      child.on('error', (error: Error) => {
        // spawn 失败（如 python 路径不存在）：无论当前状态都转入 dead
        this._markDead(`转录服务启动失败：${error.message}`);
      });
      child.on('exit', (code: number | null) => {
        // 启动期退出 = 启动失败；就绪后退出 = 运行中死亡。
        // 两种情况都是 dead 终态（不自动重启，防崩溃循环），
        // 后续 submit 由 waitReady 快速失败，不再打 HTTP。
        this.exited = true;
        this._markDead(`转录服务进程退出（code=${code ?? 'null'}），请重启服务`);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._markDead(`转录服务启动失败：${message}`);
      return;
    }

    const deadline = this.nowImpl() + this.config.sidecarLoadMs;
    while (this.state === 'starting' && this.nowImpl() < deadline) {
      if (await this._probeHealth()) {
        this.state = 'ready';
        this.resolveReady?.();
        process.stderr.write(`[asr-sidecar] 就绪 ${this.baseUrl}\n`);
        return;
      }
      await this.sleepImpl(HEALTH_POLL_INTERVAL_MS);
    }
    if (this.state === 'starting') {
      this._markDead('转录服务初始化超时（模型加载未就绪），请重启服务');
    }
  }

  private async _probeHealth(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${HEALTH_PATH}`, {
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private _markDead(reason: string): void {
    if (this.state === 'dead') return;
    this.state = 'dead';
    this.deadReason = reason;
    process.stderr.write(`[asr-sidecar] ${reason}\n`);
    // 唤醒等待中的 waitReady（其 Promise.race 会接住；构造函数里也挂了空 catch
    // 防无人等待时的 unhandledRejection）
    this.rejectReady?.(new AsrProviderError('unavailable', reason));
  }

  private _forwardLog(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const text = chunk.toString('utf8').trimEnd();
    if (text === '') return;
    const prefix = stream === 'stdout' ? '[asr-sidecar:out]' : '[asr-sidecar:err]';
    process.stderr.write(`${prefix} ${text}\n`);
  }
}

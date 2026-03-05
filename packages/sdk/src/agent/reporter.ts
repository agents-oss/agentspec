/**
 * AgentSpecReporter — agent-side SDK module.
 *
 * Runs live health checks (model, MCP, memory, services) inside the agent
 * process where full connectivity is available. Caches the result with a
 * configurable TTL and exposes it via a standard HTTP handler mounted at
 * GET /agentspec/health.
 *
 * Usage (Fastify):
 *   const reporter = new AgentSpecReporter(manifest, { refreshIntervalMs: 30_000 })
 *   reporter.start()
 *   await app.register(agentSpecFastifyPlugin(reporter))
 *
 * Usage (Express):
 *   const reporter = new AgentSpecReporter(manifest)
 *   reporter.start()
 *   app.use('/agentspec', agentSpecExpressRouter(reporter))
 */

import { runHealthCheck } from '../health/index.js'
import { runAudit } from '../audit/index.js'
import type { AgentSpecManifest } from '../schema/manifest.schema.js'
import type { HealthReport } from '../health/index.js'
import type { PushModeOptions } from './push.js'

export interface ReporterOptions {
  /**
   * How often to refresh health checks in the background.
   * Default: 30_000 ms (30 seconds)
   */
  refreshIntervalMs?: number
  /**
   * Maximum age before a cached result is considered stale and triggers a
   * synchronous refresh on the next getReport() call.
   * Default: 60_000 ms (60 seconds)
   */
  staleAfterMs?: number
}

interface CachedReport {
  report: HealthReport
  ts: number
}

export class AgentSpecReporter {
  private cached: CachedReport | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private _pushTimer: ReturnType<typeof setInterval> | null = null
  private readonly refreshIntervalMs: number
  private readonly staleAfterMs: number
  private refreshing = false
  private stopped = false
  private readonly registeredTools = new Set<string>()

  constructor(
    private readonly manifest: AgentSpecManifest,
    private readonly opts: ReporterOptions = {},
  ) {
    this.refreshIntervalMs = opts.refreshIntervalMs ?? 30_000
    this.staleAfterMs = opts.staleAfterMs ?? 60_000
  }

  /**
   * Register a tool handler by name.
   * Only registered tools report status: 'pass' in the live health check.
   * Declared tools that are not registered report status: 'fail'.
   *
   * Call this once per tool after wiring up your tool handlers:
   *   reporter.registerTool('search-arxiv', handler)
   *
   * The handler argument is accepted but not called — it is retained solely so
   * callers can pass the real function object for documentation purposes.
   */
  registerTool(name: string, _handler?: unknown): void {
    this.registeredTools.add(name)
  }

  /**
   * Start background refresh. Call once during app startup.
   * The first refresh runs immediately (non-blocking).
   */
  start(): void {
    if (this.timer !== null) return // already started

    // Kick off first refresh immediately (non-blocking, errors swallowed)
    void this.refresh()

    this.timer = setInterval(() => {
      void this.refresh()
    }, this.refreshIntervalMs)

    // Don't prevent Node.js from exiting if the app doesn't call stop()
    if (this.timer.unref) {
      this.timer.unref()
    }
  }

  /**
   * Stop background refresh. Call during graceful shutdown.
   * After stop(), getReport() will no longer trigger new checks.
   */
  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Returns the cached HealthReport.
   * If no cached result exists or the cache is stale, runs checks synchronously.
   * After stop() is called, returns the last cached result (no new checks run).
   */
  async getReport(): Promise<HealthReport> {
    const now = Date.now()

    if (this.cached && (this.stopped || now - this.cached.ts < this.staleAfterMs)) {
      return this.cached.report
    }

    // First call or stale — run synchronously
    await this.refresh()
    return this.cached!.report
  }

  /**
   * Standard HTTP handler. Mount at GET /agentspec/health.
   * Returns 200 with the HealthReport as JSON.
   *
   * Compatible with any framework that accepts (req, res) handlers
   * with res.status() and res.json().
   */
  httpHandler(): (
    req: unknown,
    res: { json(body: unknown): void; status(code: number): { json(body: unknown): void } },
  ) => Promise<void> {
    return async (_req, res) => {
      try {
        const report = await this.getReport()
        res.status(200).json(report)
      } catch (err) {
        res.status(500).json({ error: String(err) })
      }
    }
  }

  /**
   * Start sending heartbeats to the control plane.
   * Fires immediately, then repeats every `intervalSeconds` (default 30).
   * Idempotent — calling twice does not create a second timer.
   */
  startPushMode(opts: PushModeOptions): void {
    if (this._pushTimer !== null) return // idempotent

    const intervalMs = (opts.intervalSeconds ?? 30) * 1_000

    // Fire immediately (non-blocking)
    void this._pushHeartbeat(opts)

    this._pushTimer = setInterval(() => {
      void this._pushHeartbeat(opts)
    }, intervalMs)

    // Don't prevent Node.js from exiting
    if (this._pushTimer.unref) {
      this._pushTimer.unref()
    }
  }

  private async _pushHeartbeat(opts: PushModeOptions): Promise<void> {
    try {
      const health = await this.getReport()
      const gap = runAudit(this.manifest)

      // Build payload, cap at 64 KB by trimming checks
      const trimmedChecks = [...health.checks]
      let body = JSON.stringify({ health, gap })
      if (body.length > 65_536) {
        while (trimmedChecks.length > 0) {
          trimmedChecks.pop()
          body = JSON.stringify({ health: { ...health, checks: trimmedChecks }, gap })
          if (body.length <= 65_536) break
        }
      }

      let res: Response
      try {
        res = await fetch(`${opts.controlPlaneUrl}/api/v1/heartbeat`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${opts.apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
        })
      } catch (err) {
        const sanitized = String(err).split(opts.apiKey).join('[REDACTED]')
        opts.onError?.(new Error(sanitized))
        return
      }

      if (!res.ok) {
        opts.onError?.(new Error(`Heartbeat failed: HTTP ${res.status}`))
      }
    } catch (err) {
      const sanitized = String(err).split(opts.apiKey).join('[REDACTED]')
      opts.onError?.(new Error(sanitized))
    }
  }

  /** Stop sending heartbeats to the control plane. */
  stopPushMode(): void {
    if (this._pushTimer !== null) {
      clearInterval(this._pushTimer)
      this._pushTimer = null
    }
  }

  /** Returns true if heartbeats are currently being sent. */
  isPushModeActive(): boolean {
    return this._pushTimer !== null
  }

  private async refresh(): Promise<void> {
    if (this.stopped || this.refreshing) return // stopped or concurrent refresh in flight
    this.refreshing = true

    try {
      const report = await runHealthCheck(this.manifest, {
        checkModel: true,
        checkMcp: true,
        checkMemory: true,
        checkServices: true,
      })

      // Add tool checks for all declared tools.
      // A tool reports 'pass' only if registerTool() was called for it.
      // Unregistered tools report 'fail' — the caller must wire handlers explicitly.
      const toolChecks = (this.manifest.spec.tools ?? []).map((tool) => {
        const registered = this.registeredTools.has(tool.name)
        return {
          id: `tool:${tool.name}` as const,
          category: 'tool' as const,
          status: registered ? ('pass' as const) : ('fail' as const),
          severity: 'info' as const,
          ...(registered ? {} : { message: 'Handler not registered — call reporter.registerTool()' }),
        }
      })

      const toolPassed = toolChecks.filter((c) => c.status === 'pass').length
      const toolFailed = toolChecks.filter((c) => c.status === 'fail').length

      const enrichedReport: HealthReport = {
        ...report,
        checks: [...report.checks, ...toolChecks],
        summary: {
          ...report.summary,
          passed: report.summary.passed + toolPassed,
          failed: report.summary.failed + toolFailed,
        },
      }

      this.cached = { report: enrichedReport, ts: Date.now() }
    } catch {
      // Preserve the previous cache on error — don't reset to null.
      // Always advance the timestamp so repeated failures don't cause a retry
      // storm (getReport would re-trigger refresh on every call otherwise).
      if (!this.cached) {
        this.cached = {
          ts: Date.now(),
          report: {
            agentName: this.manifest.metadata.name,
            timestamp: new Date().toISOString(),
            status: 'unhealthy',
            summary: { passed: 0, failed: 1, warnings: 0, skipped: 0 },
            checks: [
              {
                id: 'reporter:internal-error',
                category: 'env',
                status: 'fail',
                severity: 'error',
                message: 'AgentSpecReporter failed to run health checks',
              },
            ],
          },
        }
      } else {
        // Advance the cached timestamp so the stale check in getReport() won't
        // immediately re-trigger another refresh that will also fail.
        this.cached = { ...this.cached, ts: Date.now() }
      }
    } finally {
      this.refreshing = false
    }
  }
}

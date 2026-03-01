import { loadManifest } from '@agentspec/sdk'
import { config } from './config.js'
import { AuditRing } from './audit-ring.js'
import { buildProxyApp } from './proxy.js'
import { buildControlPlaneApp } from './control-plane/index.js'
import { log } from './logger.js'

async function main(): Promise<void> {
  const { manifest } = loadManifest(config.manifestPath)

  const auditRing = new AuditRing(config.auditRingSize)
  const startedAt = Date.now()

  const proxyApp = await buildProxyApp(manifest, { auditRing })
  const cpApp = await buildControlPlaneApp(manifest, auditRing, { startedAt })

  await proxyApp.listen({ port: config.proxyPort, host: '0.0.0.0' })
  await cpApp.listen({ port: config.controlPlanePort, host: '0.0.0.0' })

  log.info('sidecar started', {
    proxy: config.proxyPort,
    controlPlane: config.controlPlanePort,
    agent: manifest.metadata.name,
  })

  // Graceful shutdown — handle SIGTERM (Docker/K8s stop) and SIGINT (Ctrl-C)
  const shutdown = async (signal: string): Promise<void> => {
    log.info('shutdown signal received', { signal })
    try {
      await Promise.all([proxyApp.close(), cpApp.close()])
    } catch (err) {
      log.error('error during shutdown', { err: String(err) })
    }
    process.exit(0)
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  log.error('fatal startup error', { err: String(err) })
  process.exit(1)
})

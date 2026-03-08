/**
 * Resolve cluster connection config: per-call args override env vars.
 *
 * Priority: explicit arg > AGENTSPEC_CONTROL_PLANE_URL / AGENTSPEC_ADMIN_KEY env > undefined
 */

export interface ClusterConfig {
  controlPlaneUrl?: string
  adminKey?: string
}

export function resolveCluster(args: ClusterConfig): ClusterConfig {
  return {
    controlPlaneUrl: args.controlPlaneUrl || process.env['AGENTSPEC_CONTROL_PLANE_URL'] || undefined,
    adminKey: args.adminKey || process.env['AGENTSPEC_ADMIN_KEY'] || undefined,
  }
}

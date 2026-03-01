/**
 * PushModeOptions — configuration for AgentSpecReporter.startPushMode().
 *
 * Two env vars are enough to activate push mode:
 *   AGENTSPEC_URL=https://control-plane.agentspec.io
 *   AGENTSPEC_KEY=<key from agentspec register>
 */
export interface PushModeOptions {
  /** Control plane base URL, e.g. https://control-plane.agentspec.io */
  controlPlaneUrl: string
  /** Bearer token obtained from `agentspec register` or POST /api/v1/register */
  apiKey: string
  /** Heartbeat interval in seconds. Default: 30 */
  intervalSeconds?: number
  /** Called on HTTP errors or network failures. Push mode stays active. */
  onError?: (err: Error) => void
}

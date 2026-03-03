export interface AuditEntry {
  requestId: string
  timestamp: string
  method: string
  path: string
  statusCode?: number
  durationMs?: number
  upstreamMs?: number
  excerpt?: string
  /** OPA violation IDs that fired on this request (track or enforce mode). */
  opaViolations?: string[]
  /** true when enforce mode blocked this request with a 403 before upstream. */
  opaBlocked?: boolean
  // ── Behavioral fields (set by HeaderReporting or EventPush from the agent) ──
  /** Guardrail types that actually ran during this request (from agent). */
  guardrailsInvoked?: string[]
  /** Tool names that were called during this request (from agent). */
  toolsCalled?: string[]
  /** Model calls recorded during this request. */
  modelCalls?: { modelId: string; tokenCount: number }[]
  /** true when OPA evaluated real behavioral data and allowed the request. */
  behavioralCompliant?: boolean
}

/**
 * O(1) circular ring buffer for structured audit log entries.
 *
 * Uses head/tail indices on a pre-allocated array so eviction on overflow
 * is O(1) rather than the O(n) cost of Array.shift().
 *
 * Subscribers receive each new entry synchronously as it is pushed.
 */
export class AuditRing {
  private readonly items: (AuditEntry | undefined)[]
  private readonly maxSize: number
  private head = 0  // index of the oldest entry (when full)
  private count = 0 // number of valid entries currently stored
  private readonly listeners = new Set<(entry: AuditEntry) => void>()

  constructor(maxSize = 1000) {
    this.maxSize = maxSize
    this.items = new Array<AuditEntry | undefined>(maxSize).fill(undefined)
  }

  push(entry: AuditEntry): void {
    if (this.count < this.maxSize) {
      // Ring has room — write at tail
      this.items[(this.head + this.count) % this.maxSize] = entry
      this.count++
    } else {
      // Ring is full — overwrite the oldest slot and advance head
      this.items[this.head] = entry
      this.head = (this.head + 1) % this.maxSize
    }

    for (const listener of this.listeners) {
      listener(entry)
    }
  }

  getAll(): AuditEntry[] {
    const result: AuditEntry[] = []
    for (let i = 0; i < this.count; i++) {
      const entry = this.items[(this.head + i) % this.maxSize]
      if (entry !== undefined) result.push(entry)
    }
    return result
  }

  findById(requestId: string): AuditEntry | undefined {
    for (let i = 0; i < this.count; i++) {
      const entry = this.items[(this.head + i) % this.maxSize]
      if (entry?.requestId === requestId) return entry
    }
    return undefined
  }

  /**
   * Merge partial fields into an existing entry identified by requestId.
   * Returns true if found and updated, false if not found.
   * O(n) scan — same as findById.
   */
  updateById(requestId: string, partial: Partial<AuditEntry>): boolean {
    for (let i = 0; i < this.count; i++) {
      const entry = this.items[(this.head + i) % this.maxSize]
      if (entry?.requestId === requestId) {
        // Whitelist: only behavioral fields may be updated from untrusted EventPush.
        // Identity fields (requestId, timestamp, method, path, statusCode, durationMs,
        // upstreamMs, excerpt) are immutable after push().
        if (partial.guardrailsInvoked !== undefined) entry.guardrailsInvoked = partial.guardrailsInvoked
        if (partial.toolsCalled !== undefined) entry.toolsCalled = partial.toolsCalled
        if (partial.modelCalls !== undefined) entry.modelCalls = partial.modelCalls
        if (partial.behavioralCompliant !== undefined) entry.behavioralCompliant = partial.behavioralCompliant
        if (partial.opaViolations !== undefined) entry.opaViolations = partial.opaViolations
        return true
      }
    }
    return false
  }

  /** Subscribe to new entries. Returns an unsubscribe function. */
  subscribe(listener: (entry: AuditEntry) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get size(): number {
    return this.count
  }
}

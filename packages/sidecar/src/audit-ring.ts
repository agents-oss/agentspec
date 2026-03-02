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

  /** Subscribe to new entries. Returns an unsubscribe function. */
  subscribe(listener: (entry: AuditEntry) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get size(): number {
    return this.count
  }
}

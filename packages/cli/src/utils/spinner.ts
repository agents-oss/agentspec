/**
 * TTY-safe spinner wrapper.
 *
 * In interactive terminals, delegates to @clack/prompts spinner (animated).
 * In non-TTY environments (CI, VSCode Output panel, piped stdout), falls back
 * to simple console.log so ANSI escape codes don't pollute the output.
 *
 * `message` is always a function (matching @clack/prompts spinner API).
 */
import { spinner as clackSpinner } from '@clack/prompts'

export interface Spinner {
  start(msg?: string): void
  stop(msg?: string): void
  message(msg?: string): void
}

function createFallbackSpinner(): Spinner {
  let _current = ''
  return {
    start(msg?: string) {
      if (msg) _current = msg
      console.log(_current)
    },
    stop(msg?: string) {
      if (msg) _current = msg
      console.log(_current)
    },
    message(msg?: string) {
      if (msg) _current = msg
    },
  }
}

export function spinner(): Spinner {
  if (process.stdout.isTTY) {
    return clackSpinner() as Spinner
  }
  return createFallbackSpinner()
}

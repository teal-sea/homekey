import { describe, expect, it } from 'vitest'
import { RAMP, rampTo } from './graph'

// A param whose `value` is read off its own timeline, the way a browser can
// report it: cancel a glide in flight and `value` falls back to where it began.
class TimelineParam {
  private events: { kind: 'set' | 'ramp'; value: number; time: number }[] = []
  constructor(private readonly clock: { currentTime: number }, private readonly initial: number) {}

  at(t: number): number {
    let value = this.initial
    let since = 0
    for (const e of this.events) {
      if (e.time <= t) { value = e.value; since = e.time; continue }
      if (e.kind === 'ramp') return value + (e.value - value) * (t - since) / (e.time - since)
      break
    }
    return value
  }

  get value(): number { return this.at(this.clock.currentTime) }
  cancelScheduledValues(t: number) { this.events = this.events.filter(e => e.time < t) }
  setValueAtTime(value: number, time: number) { this.add({ kind: 'set', value, time }) }
  linearRampToValueAtTime(value: number, time: number) { this.add({ kind: 'ramp', value, time }) }
  private add(e: { kind: 'set' | 'ramp'; value: number; time: number }) {
    this.events.push(e)
    this.events.sort((a, b) => a.time - b.time)
  }
}

describe('rampTo', () => {
  it('glides from the current value to the target over RAMP seconds', () => {
    const ctx = { currentTime: 2 }
    const param = new TimelineParam(ctx, 1)
    rampTo(param as unknown as AudioParam, ctx as unknown as BaseAudioContext, 0)
    expect(param.at(2)).toBe(1)
    expect(param.at(2 + RAMP / 2)).toBeCloseTo(0.5, 9)
    expect(param.at(2 + RAMP)).toBe(0)
  })

  it('takes over a glide in flight from where it got to, never from where it began', () => {
    const ctx = { currentTime: 1 }
    const param = new TimelineParam(ctx, 0)
    const asParam = param as unknown as AudioParam
    const asCtx = ctx as unknown as BaseAudioContext
    rampTo(asParam, asCtx, 1)
    ctx.currentTime = 1 + RAMP / 2 // half way up
    rampTo(asParam, asCtx, 0)
    expect(param.at(ctx.currentTime)).toBeCloseTo(0.5, 9)
    // Sampled through the turn-around: no jump back to 0 and up again.
    let prev = param.at(ctx.currentTime)
    for (let t = ctx.currentTime; t <= ctx.currentTime + RAMP; t += RAMP / 50) {
      const v = param.at(t)
      expect(v).toBeLessThanOrEqual(prev + 1e-12)
      prev = v
    }
    expect(param.at(ctx.currentTime + RAMP)).toBe(0)
  })

  it('accepts its own glide time', () => {
    const ctx = { currentTime: 0 }
    const param = new TimelineParam(ctx, 1)
    rampTo(param as unknown as AudioParam, ctx as unknown as BaseAudioContext, 0, 0.5)
    expect(param.at(0.25)).toBeCloseTo(0.5, 9)
  })
})

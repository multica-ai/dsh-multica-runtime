import { describe, expect, it } from 'vitest'
import { mapQuestionsForWire, settlePendingQuestion } from '../src/index.js'
import { encodeFrame, type RuntimeAnswerItem } from '../src/protocol.js'

describe('mapQuestionsForWire', () => {
  it('copies declared fields only, preserving the plan-review intent', () => {
    expect(mapQuestionsForWire([{
      id: 'plan',
      question: 'Approve this plan and leave plan mode?',
      detail: '# Plan\n1. do the thing',
      header: 'Plan review',
      options: [{ label: 'Approve', description: 'Leave plan mode.' }, { label: 'Keep planning' }],
      intent: { kind: 'plan-review', approve: 'Approve', callId: 'c9' },
    }])).toEqual([{
      id: 'plan',
      question: 'Approve this plan and leave plan mode?',
      detail: '# Plan\n1. do the thing',
      header: 'Plan review',
      options: [{ label: 'Approve', description: 'Leave plan mode.' }, { label: 'Keep planning' }],
      intent: { kind: 'plan-review', approve: 'Approve', callId: 'c9' },
    }])
  })

  it('omits absent optionals instead of sending undefined', () => {
    expect(mapQuestionsForWire([{ id: 'q1', question: 'Ship it?' }])).toEqual([
      { id: 'q1', question: 'Ship it?' },
    ])
  })
})

describe('settlePendingQuestion', () => {
  it('resolves the parked ask for the matching call id', () => {
    const answers: RuntimeAnswerItem[] = [{ id: 'plan', selected: ['Approve'] }]
    const resolved: RuntimeAnswerItem[][] = []
    const pending = { callId: 'q-1', resolve: (value: RuntimeAnswerItem[]) => resolved.push(value) }
    expect(settlePendingQuestion(pending, { call_id: 'q-1', answers })).toBe(true)
    expect(resolved).toEqual([answers])
  })

  it('ignores stale and duplicate answers', () => {
    expect(settlePendingQuestion(undefined, { call_id: 'q-1', answers: [] })).toBe(false)
    const resolved: RuntimeAnswerItem[][] = []
    const pending = { callId: 'q-2', resolve: (value: RuntimeAnswerItem[]) => resolved.push(value) }
    expect(settlePendingQuestion(pending, { call_id: 'q-1', answers: [] })).toBe(false)
    expect(resolved).toEqual([])
  })
})

describe('question frame encoding', () => {
  it('encodes exactly one JSON line with the questions payload', () => {
    expect(encodeFrame({
      v: 1,
      type: 'question',
      request_id: 'request-1',
      call_id: 'q-1',
      questions: [{ id: 'plan', question: 'Approve?', intent: { kind: 'plan-review', approve: 'Approve' } }],
    })).toBe('{"v":1,"type":"question","request_id":"request-1","call_id":"q-1","questions":[{"id":"plan","question":"Approve?","intent":{"kind":"plan-review","approve":"Approve"}}]}\n')
  })
})

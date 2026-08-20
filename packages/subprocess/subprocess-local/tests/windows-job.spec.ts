import { describe, expect, it } from 'vitest'
import { createWindowsProcessJob } from '../src/windows-job.ts'
import type { WindowsJobInternals } from '../src/windows-job.ts'
import type { NativePtr } from '../src/windows-inspector.ts'

const ptr = (value: number): NativePtr => BigInt(value) as NativePtr

function fakeWindowsJob() {
  const job = ptr(10)
  const process = ptr(20)
  const closed: NativePtr[] = []
  const assigned: Array<[NativePtr, NativePtr]> = []
  let createResult: NativePtr | null = job
  let openResult: NativePtr | null = process
  let setResult = true
  let assignResult = true
  let terminateResult = true
  let active: number | undefined = 0
  let terminations = 0
  const internals: WindowsJobInternals = {
    createJob: () => createResult,
    setKillOnClose: () => setResult,
    openProcess: () => openResult,
    assignProcess: (jobHandle, processHandle) => {
      assigned.push([jobHandle, processHandle])
      return assignResult
    },
    terminateJob: () => {
      terminations += 1
      return terminateResult
    },
    activeProcesses: () => active,
    closeHandle: (handle) => { closed.push(handle) },
    lastError: () => 5,
  }
  return {
    internals, job, process, closed, assigned,
    setCreateResult: (value: NativePtr | null) => { createResult = value },
    setOpenResult: (value: NativePtr | null) => { openResult = value },
    failSet: () => { setResult = false },
    failAssign: () => { assignResult = false },
    failTerminate: () => { terminateResult = false },
    setActive: (value: number | undefined) => { active = value },
    terminations: () => terminations,
  }
}

describe('Windows Job Object ownership', () => {
  it('assigns, observes, terminates, and closes one Job', () => {
    const fake = fakeWindowsJob()
    const job = createWindowsProcessJob(fake.internals)
    job.assign(42)
    expect(fake.assigned).toEqual([[fake.job, fake.process]])
    expect(fake.closed).toEqual([fake.process])

    fake.setActive(2)
    expect(job.hasActiveProcesses()).toBe(true)
    fake.setActive(0)
    expect(job.hasActiveProcesses()).toBe(false)
    job.terminate()
    expect(fake.terminations()).toBe(1)

    job.close()
    job.close()
    expect(fake.closed).toEqual([fake.process, fake.job])
    expect(() => job.hasActiveProcesses()).toThrow('already closed')
  })

  it('rejects an invalid Job creation handle', () => {
    const fake = fakeWindowsJob()
    fake.setCreateResult(null)
    expect(() => createWindowsProcessJob(fake.internals))
      .toThrow('CreateJobObjectW failed with Windows error 5')
    expect(fake.closed).toEqual([])
  })

  it('closes a Job that cannot enable kill-on-close', () => {
    const fake = fakeWindowsJob()
    fake.failSet()
    expect(() => createWindowsProcessJob(fake.internals))
      .toThrow('SetInformationJobObject failed with Windows error 5')
    expect(fake.closed).toEqual([fake.job])
  })

  it('rejects an unreadable process before assignment', () => {
    const fake = fakeWindowsJob()
    const job = createWindowsProcessJob(fake.internals)
    fake.setOpenResult(null)
    expect(() => { job.assign(42) }).toThrow('OpenProcess for Job assignment failed with Windows error 5')
    expect(fake.assigned).toEqual([])
  })

  it('closes the process handle when assignment fails', () => {
    const fake = fakeWindowsJob()
    const job = createWindowsProcessJob(fake.internals)
    fake.failAssign()
    expect(() => { job.assign(42) }).toThrow('AssignProcessToJobObject failed with Windows error 5')
    expect(fake.closed).toEqual([fake.process])
  })

  it('reports Job liveness and termination failures', () => {
    const fake = fakeWindowsJob()
    const job = createWindowsProcessJob(fake.internals)
    fake.setActive(undefined)
    expect(() => job.hasActiveProcesses()).toThrow('QueryInformationJobObject failed with Windows error 5')
    fake.failTerminate()
    expect(() => { job.terminate() }).toThrow('TerminateJobObject failed with Windows error 5')
  })
})

describe.skipIf(process.platform !== 'win32')('real Windows Job Object bindings', () => {
  it('creates and closes an empty kill-on-close Job', () => {
    const job = createWindowsProcessJob()
    expect(job.hasActiveProcesses()).toBe(false)
    job.close()
  })
})

/**
 * Windows Job Object ownership for ordinary managed process trees.
 * @module dsh-subprocess-local/windows-job
 */

import koffi from 'koffi'
import { isInvalidHandle } from './windows-inspector.ts'
import type { NativePtr } from './windows-inspector.ts'

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
const JOB_OBJECT_EXTENDED_LIMIT_SIZE = 144
const JOB_OBJECT_EXTENDED_LIMIT_FLAGS_OFFSET = 16
const JOB_OBJECT_BASIC_ACCOUNTING_SIZE = 48
const JOB_OBJECT_ACTIVE_PROCESSES_OFFSET = 40
const PROCESS_TERMINATE = 0x0001
const PROCESS_SET_QUOTA = 0x0100

/** Injectable Win32 operations used by {@link createWindowsProcessJob}. */
export interface WindowsJobInternals {
  /** Create an unnamed Job Object. */
  createJob(): NativePtr | null
  /** Configure `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. */
  setKillOnClose(job: NativePtr): boolean
  /** Open a process for Job assignment. */
  openProcess(pid: number): NativePtr | null
  /** Assign an open process to the Job. */
  assignProcess(job: NativePtr, process: NativePtr): boolean
  /** Force-terminate every active Job member. */
  terminateJob(job: NativePtr): boolean
  /** Return the number of active Job members, or undefined on query failure. */
  activeProcesses(job: NativePtr): number | undefined
  /** Close one Win32 handle. */
  closeHandle(handle: NativePtr): void
  /** Return the calling thread's last Win32 error code. */
  lastError(): number
}

/** Owned Windows Job used by the local subprocess handle. */
export interface WindowsProcessJob {
  /** Assign the waiting guardian before it can launch the requested command. */
  assign(pid: number): void
  /** Return whether any process in the Job can still execute. */
  hasActiveProcesses(): boolean
  /** Force-terminate every process in the Job. */
  terminate(): void
  /** Release the Job after all members have exited. */
  close(): void
}

function win32Failure(api: string, internals: WindowsJobInternals): Error {
  return new Error(`subprocess-local: ${api} failed with Windows error ${internals.lastError()}`)
}

class KernelWindowsProcessJob implements WindowsProcessJob {
  private handle: NativePtr | undefined

  constructor(handle: NativePtr, private readonly internals: WindowsJobInternals) {
    this.handle = handle
  }

  assign(pid: number): void {
    const process = this.internals.openProcess(pid)
    if (isInvalidHandle(process)) throw win32Failure('OpenProcess for Job assignment', this.internals)
    const processHandle = process as NativePtr
    try {
      if (!this.internals.assignProcess(this.job(), processHandle)) {
        throw win32Failure('AssignProcessToJobObject', this.internals)
      }
    } finally {
      this.internals.closeHandle(processHandle)
    }
  }

  hasActiveProcesses(): boolean {
    const active = this.internals.activeProcesses(this.job())
    if (active === undefined) throw win32Failure('QueryInformationJobObject', this.internals)
    return active > 0
  }

  terminate(): void {
    if (!this.internals.terminateJob(this.job())) throw win32Failure('TerminateJobObject', this.internals)
  }

  close(): void {
    const handle = this.handle
    if (handle === undefined) return
    this.handle = undefined
    this.internals.closeHandle(handle)
  }

  private job(): NativePtr {
    if (this.handle === undefined) throw new Error('subprocess-local: Windows Job Object is already closed')
    return this.handle
  }
}

const PVOID: ReturnType<typeof koffi.pointer> = koffi.pointer('void')
let cachedInternals: WindowsJobInternals | undefined

function defaultWindowsJobInternals(): WindowsJobInternals {
  if (cachedInternals !== undefined) return cachedInternals
  const kernel32 = koffi.load('kernel32.dll')
  const bind = (
    name: string,
    result: ReturnType<typeof koffi.pointer> | string,
    args: Array<ReturnType<typeof koffi.pointer> | string>,
  ): unknown => kernel32.func('__stdcall', name, result, args)
  const createJobObjectW = bind('CreateJobObjectW', PVOID, [PVOID, 'str16']) as (security: null, name: null) => NativePtr | null
  const setInformationJobObject = bind('SetInformationJobObject', 'int', [PVOID, 'int', PVOID, 'uint32']) as (
    job: NativePtr, informationClass: number, information: Buffer, length: number,
  ) => number
  const openProcess = bind('OpenProcess', PVOID, ['uint32', 'int', 'uint32']) as (
    access: number, inherit: number, pid: number,
  ) => NativePtr | null
  const assignProcessToJobObject = bind('AssignProcessToJobObject', 'int', [PVOID, PVOID]) as (
    job: NativePtr, process: NativePtr,
  ) => number
  const terminateJobObject = bind('TerminateJobObject', 'int', [PVOID, 'uint32']) as (
    job: NativePtr, exitCode: number,
  ) => number
  const queryInformationJobObject = bind('QueryInformationJobObject', 'int', [PVOID, 'int', PVOID, 'uint32', PVOID]) as (
    job: NativePtr, informationClass: number, information: Buffer, length: number, returnedLength: null,
  ) => number
  const closeHandle = bind('CloseHandle', 'int', [PVOID]) as (handle: NativePtr) => number
  const getLastError = bind('GetLastError', 'uint32', []) as () => number
  cachedInternals = {
    createJob: () => createJobObjectW(null, null),
    setKillOnClose: (job) => {
      const information = Buffer.alloc(JOB_OBJECT_EXTENDED_LIMIT_SIZE)
      information.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_EXTENDED_LIMIT_FLAGS_OFFSET)
      return setInformationJobObject(
        job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, information, information.length,
      ) !== 0
    },
    openProcess: pid => openProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, 0, pid),
    assignProcess: (job, process) => assignProcessToJobObject(job, process) !== 0,
    terminateJob: job => terminateJobObject(job, 1) !== 0,
    activeProcesses: (job) => {
      const information = Buffer.alloc(JOB_OBJECT_BASIC_ACCOUNTING_SIZE)
      if (queryInformationJobObject(
        job, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION, information, information.length, null,
      ) === 0) return undefined
      return information.readUInt32LE(JOB_OBJECT_ACTIVE_PROCESSES_OFFSET)
    },
    closeHandle: (handle) => { closeHandle(handle) },
    lastError: () => getLastError(),
  }
  return cachedInternals
}

/**
 * Create one kill-on-close Windows Job Object.
 * @param internals - injectable Win32 operations; defaults to real koffi bindings.
 * @returns an empty owned Job ready for guardian assignment.
 */
export function createWindowsProcessJob(
  internals: WindowsJobInternals = defaultWindowsJobInternals(),
): WindowsProcessJob {
  const job = internals.createJob()
  if (isInvalidHandle(job)) throw win32Failure('CreateJobObjectW', internals)
  const jobHandle = job as NativePtr
  if (!internals.setKillOnClose(jobHandle)) {
    const error = win32Failure('SetInformationJobObject', internals)
    internals.closeHandle(jobHandle)
    throw error
  }
  return new KernelWindowsProcessJob(jobHandle, internals)
}

export interface RunResult {
  errors: Array<{ message: string; failure_type?: string; stream?: string }>
}

export interface SyncActivities {
  setup(pipelineId: string): Promise<void>
  sync(pipelineId: string, input?: unknown[]): Promise<RunResult>
  teardown(pipelineId: string): Promise<void>
}

export interface WorkflowStatus {
  phase: string
  paused: boolean
  iteration: number
}

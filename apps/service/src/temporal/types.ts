export interface RunResult {
  errors: Array<{ message: string; failure_type?: string; stream?: string }>
}

export interface WorkflowStatus {
  phase: string
  paused: boolean
  iteration: number
}

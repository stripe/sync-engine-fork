import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import ProjectionControls from '../ProjectionControls'
import type { ProjectionArtifact, ProjectionConfig } from '@/types/projection'
import { DEFAULT_PROJECTION_CONFIG } from '@/types/projection'

describe('ProjectionControls', () => {
  let onChange: ReturnType<typeof vi.fn>
  let artifact: ProjectionArtifact

  beforeEach(() => {
    onChange = vi.fn()
    artifact = {
      apiVersion: '2026-02-24',
      generatedAt: '2026-03-17T00:00:00.000Z',
      capabilities: {
        hasV2Namespace: true,
        hasExplicitForeignKeys: false,
        hasDeletedVariants: true,
        hasListEndpointMetadata: true,
        hasWebhookEventMetadata: true,
        timestampFormat: 'mixed',
        tableCount: 10,
        relationshipCount: 5,
      },
      tables: {},
      relationships: [],
      deletedVariants: [],
    }
  })

  function openControls(config: ProjectionConfig = DEFAULT_PROJECTION_CONFIG) {
    render(<ProjectionControls config={config} onChange={onChange} artifact={artifact} />)
    fireEvent.click(screen.getByRole('button', { name: /open projection controls/i }))
  }

  it('renders the collapsed summary with the trimmed filter set', () => {
    render(
      <ProjectionControls
        config={DEFAULT_PROJECTION_CONFIG}
        onChange={onChange}
        artifact={artifact}
      />
    )

    expect(screen.getByText(/v1 \+ v2/i)).toBeInTheDocument()
    expect(screen.getByText(/list:yes/i)).toBeInTheDocument()
    expect(screen.getByText(/event:yes/i)).toBeInTheDocument()
    expect(screen.getByText(/fk:hidden/i)).toBeInTheDocument()
    expect(screen.getByText(/ts:original/i)).toBeInTheDocument()
    expect(screen.getByText(/deleted:column/i)).toBeInTheDocument()
  })

  it('shows the requested control groups', () => {
    openControls()

    expect(screen.getByText('Namespace')).toBeInTheDocument()
    expect(screen.getByText('Has List Endpoint')).toBeInTheDocument()
    expect(screen.getByText('Has Webhook Event')).toBeInTheDocument()
    expect(screen.getByText('Relationship Edges')).toBeInTheDocument()
    expect(screen.getByText('Timestamps')).toBeInTheDocument()
    expect(screen.getByText('Deleted Resources')).toBeInTheDocument()
  })

  it('updates namespace, list-endpoint, and webhook-event filters', () => {
    openControls()

    fireEvent.click(screen.getByRole('button', { name: /namespace: v2/i }))
    fireEvent.click(screen.getByRole('button', { name: /has list endpoint: no/i }))
    fireEvent.click(screen.getByRole('button', { name: /has webhook event: no/i }))

    expect(onChange).toHaveBeenNthCalledWith(1, expect.objectContaining({ namespaceMode: 'v2' }))
    expect(onChange).toHaveBeenNthCalledWith(2, expect.objectContaining({ listEndpointMode: 'no' }))
    expect(onChange).toHaveBeenNthCalledWith(3, expect.objectContaining({ webhookEventMode: 'no' }))
  })

  it('lets list-endpoint and webhook filters return to either', () => {
    openControls()

    fireEvent.click(screen.getByRole('button', { name: /has list endpoint: yes/i }))
    fireEvent.click(screen.getByRole('button', { name: /has webhook event: yes/i }))

    expect(onChange).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ listEndpointMode: 'either' })
    )
    expect(onChange).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ webhookEventMode: 'either' })
    )
  })

  it('updates the pressed state when list/webhook filters are deselected in a controlled rerender', () => {
    function ControlledHarness() {
      const [config, setConfig] = React.useState<ProjectionConfig>(DEFAULT_PROJECTION_CONFIG)
      return <ProjectionControls config={config} onChange={setConfig} artifact={artifact} />
    }

    render(<ControlledHarness />)
    fireEvent.click(screen.getByRole('button', { name: /open projection controls/i }))

    const listYesButton = screen.getByRole('button', { name: /has list endpoint: yes/i })
    const listEitherButton = screen.getByRole('button', { name: /has list endpoint: either/i })
    const webhookYesButton = screen.getByRole('button', { name: /has webhook event: yes/i })
    const webhookEitherButton = screen.getByRole('button', { name: /has webhook event: either/i })

    expect(listYesButton).toHaveAttribute('aria-pressed', 'true')
    expect(listEitherButton).toHaveAttribute('aria-pressed', 'false')
    expect(webhookYesButton).toHaveAttribute('aria-pressed', 'true')
    expect(webhookEitherButton).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(listYesButton)
    fireEvent.click(webhookYesButton)

    expect(listYesButton).toHaveAttribute('aria-pressed', 'false')
    expect(listEitherButton).toHaveAttribute('aria-pressed', 'true')
    expect(webhookYesButton).toHaveAttribute('aria-pressed', 'false')
    expect(webhookEitherButton).toHaveAttribute('aria-pressed', 'true')
  })

  it('updates FK, timestamp, and deleted modes', () => {
    openControls()

    fireEvent.click(screen.getByRole('button', { name: /relationship edges: show in erd/i }))
    fireEvent.click(screen.getByRole('button', { name: /timestamps: always timestamptz/i }))
    fireEvent.click(screen.getByRole('button', { name: /deleted resources: separate table/i }))

    expect(onChange).toHaveBeenNthCalledWith(1, expect.objectContaining({ fkMode: 'yes' }))
    expect(onChange).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ timestampMode: 'timestamptz' })
    )
    expect(onChange).toHaveBeenNthCalledWith(3, expect.objectContaining({ deletedMode: 'table' }))
  })

  it('disables unsupported metadata filters and v2/deleted options', () => {
    artifact = {
      ...artifact,
      capabilities: {
        ...artifact.capabilities,
        hasV2Namespace: false,
        hasDeletedVariants: false,
        hasListEndpointMetadata: false,
        hasWebhookEventMetadata: false,
      },
    }

    openControls()

    expect(screen.getByRole('button', { name: /namespace: v2/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /namespace: v1 \+ v2/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /has list endpoint: either/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /has list endpoint: yes/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /has webhook event: either/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /has webhook event: yes/i })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: /deleted resources: separate table/i })
    ).toBeDisabled()
  })

  it('explains that FK mode toggles ERD edges only', () => {
    openControls()

    expect(
      screen.getByText(/it does not apply postgresql foreign key constraints/i)
    ).toBeInTheDocument()
    expect(screen.getByText(/low-confidence inferred edges stay hidden/i)).toBeInTheDocument()
    expect(screen.getByText(/they do not rewrite the hydrated pglite schema/i)).toBeInTheDocument()
  })

  it('documents the concrete list and webhook heuristics', () => {
    openControls()

    expect(screen.getByText(/exactly one canonical/i)).toBeInTheDocument()
    expect(screen.getByText(/mapped `x-stripeevent` type/i)).toBeInTheDocument()
  })

  it('marks the active selection', () => {
    const config: ProjectionConfig = {
      ...DEFAULT_PROJECTION_CONFIG,
      namespaceMode: 'v2',
      listEndpointMode: 'either',
      webhookEventMode: 'either',
    }

    openControls(config)

    expect(screen.getByRole('button', { name: /namespace: v2/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: /has list endpoint: either/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: /has webhook event: either/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })
})

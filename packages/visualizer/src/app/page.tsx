'use client'

import dynamic from 'next/dynamic'

const VisualizerClient = dynamic(() => import('./VisualizerClient'), {
  ssr: false,
  loading: () => <LoadingSkeleton />,
})

export default function VisualizerPage() {
  return <VisualizerClient />
}

function LoadingSkeleton() {
  return (
    <div className="flex h-screen w-full items-center justify-center bg-slate-50">
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-slate-200 bg-white px-8 py-7 shadow-sm">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-slate-200 border-t-indigo-600" />
        <p className="text-sm text-slate-500">Loading visualizer...</p>
      </div>
    </div>
  )
}

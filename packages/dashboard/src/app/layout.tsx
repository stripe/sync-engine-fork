import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Stripe Sync Dashboard',
  description: 'Deploy and monitor Stripe sync to Supabase',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="m-0 font-sans antialiased">{children}</body>
    </html>
  )
}

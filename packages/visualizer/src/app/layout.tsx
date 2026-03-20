import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Schema Visualizer',
  description: 'Explore generated schema data with a browser-based ERD visualizer',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="m-0 font-sans antialiased">{children}</body>
    </html>
  )
}

import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  eslint: {
    // Disable ESLint during builds - code will be linted separately
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Check types during build but be lenient with errors for now
    ignoreBuildErrors: false,
  },
  transpilePackages: ['stripe-experiment-sync'],
  serverExternalPackages: ['esbuild'],
  webpack: (config, { isServer }) => {
    // Preserve existing esbuild externals config
    if (isServer) {
      config.externals = config.externals || []
      if (Array.isArray(config.externals)) {
        config.externals.push('esbuild')
      }
    }

    // Add WASM support for PGlite
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    }

    // Configure WASM file handling
    config.module.rules.push({
      test: /\.wasm$/,
      type: 'asset/resource',
    })

    return config
  },
  // Add headers for SharedArrayBuffer support (required by PGlite)
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'require-corp',
          },
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
        ],
      },
    ]
  },
}

export default nextConfig

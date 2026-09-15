import { createApp } from './app.js'

const app = await createApp()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    // Close sockets first so clients start reconnecting to another instance immediately.
    await app.close()
    process.exit(0)
  })
}

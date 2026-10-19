// Usage: npm run dev -w @stopsignal/console, with the hail service running on port 8080.
// Serves the console at http://localhost:5173 and passes its signal stream and acknowledgement to the service, so
// the browser sees one origin, as it does behind Caddy on the host (ADR-015 decision 2).
import { defineConfig } from 'vite';

const service = 'http://127.0.0.1:8080';
export default defineConfig({ server: { proxy: { '/signals': service, '/ack': service } } });
